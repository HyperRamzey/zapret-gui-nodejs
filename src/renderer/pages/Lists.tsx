/** Lists: editor for user `*-user.txt` files in data/lists (exclude + general). */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useUi } from '../store'
import { Badge, Btn, Card, Spinner } from '../components/ui'
import type { UserListMeta } from '../../shared/types'
import { countListEntries as countEntries, dedupListContent as dedupContent, mergeAddEntries, sortListContent as sortContent, splitAddParts } from '../lib/ui-logic'

export default function Lists(): React.JSX.Element {
  const { t, setError } = useUi()
  const [metas, setMetas] = useState<UserListMeta[] | null>(null)
  const [selected, setSelected] = useState<string>('')
  const [content, setContent] = useState<string>('')
  const [original, setOriginal] = useState<string>('')
  const [loadingFile, setLoadingFile] = useState<boolean>(false)
  const [saving, setSaving] = useState<boolean>(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [addValue, setAddValue] = useState<string>('')
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  useEffect(() => {
    void (async () => {
      try {
        const list = await window.zapret.listUserLists()
        setMetas(list)
        if (list.length > 0) setSelected(list[0].name)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selected) return
    const requestName = selected
    let cancelled = false
    setSavedAt(null)
    void (async () => {
      setLoadingFile(true)
      try {
        const text = await window.zapret.readUserList(requestName)
        // The user may have switched files while loading: a stale response
        // must never overwrite the newly selected file (would corrupt on save).
        if (cancelled) return
        setContent(text)
        setOriginal(text)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoadingFile(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  const dirty = content !== original
  const entries = useMemo(() => countEntries(content), [content])
  const meta = metas?.find((m) => m.name === selected) ?? null
  const isGeneral = selected === 'list-general-user.txt'

  async function reload(): Promise<void> {
    const requestName = selected
    try {
      const [list, text] = await Promise.all([window.zapret.listUserLists(), window.zapret.readUserList(requestName)])
      setMetas(list)
      // Guard against a tab switch mid-reload (same stale-write hazard as above).
      if (selectedRef.current !== requestName) return
      setContent(text)
      setOriginal(text)
      setSavedAt(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function save(): Promise<void> {
    if (!selected || saving) return
    const requestName = selected
    const requestContent = content
    setSaving(true)
    try {
      const updated = await window.zapret.saveUserList(requestName, requestContent)
      // Only commit if the user didn't switch files mid-save.
      if (selectedRef.current !== requestName) return
      setOriginal(requestContent)
      setMetas((prev) => (prev ? prev.map((m) => (m.name === updated.name ? updated : m)) : prev))
      setSavedAt(new Date().toLocaleTimeString())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  function addEntries(): void {
    if (splitAddParts(addValue).length === 0) return
    const merged = mergeAddEntries(content, addValue)
    if (merged === null) {
      setAddValue('')
      return
    }
    setContent(merged)
    setAddValue('')
  }

  if (metas === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h1 className="text-xl font-semibold">{t('lists.title')}</h1>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('lists.hint')}</p>

      <div className="flex flex-wrap gap-2">
        {metas.map((m) => (
          <button
            key={m.name}
            onClick={() => setSelected(m.name)}
            className={`rounded-lg px-3 py-1.5 font-mono text-xs transition active:scale-[0.98] ${
              selected === m.name
                ? 'bg-sky-600 text-white'
                : 'bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600'
            }`}
          >
            {m.name}
            <span className="ml-2 opacity-70">{m.lines}</span>
          </button>
        ))}
      </div>

      {selected ? (
        <Card
          title={`${selected} · ${t('lists.entries').replace('{count}', String(meta?.lines ?? entries))}${
            dirty ? ' · ●' : ''
          }`}
        >
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge tone={meta?.kind === 'ipset' ? 'blue' : 'gray'}>
              {meta?.kind === 'ipset' ? 'IP/CIDR' : 'domains'}
            </Badge>
            {savedAt ? (
              <span className="text-xs text-emerald-600 dark:text-emerald-300">
                ✓ {t('lists.saved')} · {savedAt}
              </span>
            ) : null}
            <span className="flex-1" />
            <Btn variant="secondary" disabled={loadingFile || saving} onClick={() => setContent((c) => dedupContent(c))}>
              {t('lists.dedup')}
            </Btn>
            <Btn variant="secondary" disabled={loadingFile || saving} onClick={() => setContent((c) => sortContent(c))}>
              {t('lists.sort')}
            </Btn>
            <Btn variant="secondary" disabled={loadingFile || saving} onClick={() => void reload()}>
              {t('action.refresh')}
            </Btn>
            <Btn disabled={!dirty || loadingFile || saving} onClick={() => void save()}>
              {saving ? <Spinner /> : t('action.save')}
            </Btn>
          </div>

          <div className="mb-2 flex gap-2">
            <input
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addEntries()
              }}
              placeholder={t('lists.addPlaceholder')}
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-sm text-slate-900 placeholder:text-slate-400 dark:border-slate-600 dark:bg-black/40 dark:text-slate-100"
            />
            <Btn variant="secondary" onClick={addEntries}>
              {t('lists.add')}
            </Btn>
          </div>

          {loadingFile ? (
            <div className="flex items-center justify-center py-10">
              <Spinner />
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
              rows={18}
              placeholder={t('lists.empty')}
              className="w-full rounded-lg border border-slate-300 bg-white p-3 font-mono text-[13px] leading-relaxed text-slate-900 dark:border-slate-600 dark:bg-black/50 dark:text-slate-100"
            />
          )}

          {isGeneral && entries === 0 ? (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">⚠ {t('lists.neverEmpty')}</p>
          ) : null}
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">↻ {t('lists.restartHint')}</p>
        </Card>
      ) : null}
    </div>
  )
}
