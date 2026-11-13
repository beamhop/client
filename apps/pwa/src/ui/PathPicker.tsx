/**
 * PathPicker (DESIGN §9.3): ComboBox with directory completion, recent paths and a "Browse" sheet
 * (breadcrumb + folder list). Git repos get a GitBranch badge.
 *
 * Directories come from the daemon's `fs.list` (owner only, under the allowed roots, hidden and
 * always-denied paths are never returned); `listDir` overrides it (tests). Outside a provider the
 * picker still works as a plain text field.
 */
import { CaretRight, FolderSimple, GitBranch } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ButtonContext,
  ComboBox,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Button as RACButton,
  Text,
} from 'react-aria-components';
import { useMaybeBeamhop } from '../api/provider.tsx';
import { cx } from '../lib/cx.ts';
import { Button } from './Button.tsx';
import { descriptionClass, inputShell, labelClass } from './Field.tsx';
import { Sheet } from './Sheet.tsx';

export interface DirEntry {
  path: string;
  git?: boolean;
}

/** A listing of one directory (`fs.list`): its entries, parent and the roots it may browse. */
export interface DirListing {
  path: string;
  parent?: string;
  entries: DirEntry[];
}

type FsClient = { call(method: string, params?: unknown): Promise<unknown> };
type FsResult = { path: string; parent?: string; entries: { path: string; git: boolean }[] };
/** Listings are cached briefly per client so several pickers / mount rows share one `fs.list`. */
const fsCache = new WeakMap<FsClient, Map<string, { at: number; p: Promise<DirListing> }>>();
const FS_TTL_MS = 30_000;

const listVia = (client: FsClient, path: string): Promise<DirListing> => {
  let m = fsCache.get(client);
  if (!m) {
    m = new Map();
    fsCache.set(client, m);
  }
  const cache = m;
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < FS_TTL_MS) return hit.p;
  const p = (client.call('fs.list', { path }) as Promise<FsResult>).then((r) => ({
    path: r.path,
    ...(r.parent ? { parent: r.parent } : {}),
    entries: r.entries.map((e) => ({ path: e.path, git: e.git })),
  }));
  cache.set(path, { at: Date.now(), p });
  p.catch(() => cache.delete(path));
  return p;
};

/**
 * `listDir` backed by `fs.list`. Rejects when the daemon refuses (denied / outside the roots / not
 * found); resolves to an empty listing outside a <BeamhopProvider>.
 */
export const useFsListDir = (): ((path: string) => Promise<DirListing>) => {
  const client = useMaybeBeamhop()?.client as FsClient | undefined;
  return useCallback(
    (path: string) => (client ? listVia(client, path) : Promise.resolve({ path, entries: [] })),
    [client],
  );
};

/**
 * Whether `path` is the top of a git work tree, from its parent's `fs.list`: undefined until known,
 * false when it isn't (or can't be listed).
 */
export const useIsGitRepo = (path: string): boolean | undefined => {
  const listDir = useFsListDir();
  const [git, setGit] = useState<boolean | undefined>(undefined);
  const p = path.trim().replace(/\/+$/, '');
  useEffect(() => {
    let live = true;
    setGit(undefined);
    if (!p.includes('/')) {
      setGit(false);
      return;
    }
    listDir(parentOf(p)).then(
      (l) => live && setGit(l.entries.some((e) => e.path === p && e.git)),
      () => live && setGit(false),
    );
    return () => {
      live = false;
    };
  }, [p, listDir]);
  return git;
};

export interface PathPickerProps {
  label: string;
  value: string;
  onChange: (path: string) => void;
  description?: string;
  recent?: string[];
  /** Override the directory source (default: the daemon's `fs.list`). */
  listDir?: (path: string) => Promise<DirListing>;
  className?: string;
}

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) || '~' : '~');

export const PathPicker = ({
  label,
  value,
  onChange,
  description,
  recent = [],
  listDir: listDirProp,
  className,
}: PathPickerProps) => {
  const fsListDir = useFsListDir();
  const listDir = listDirProp ?? fsListDir;
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [browse, setBrowse] = useState(false);
  const [cwd, setCwd] = useState('~');
  const [cwdEntries, setCwdEntries] = useState<DirEntry[]>([]);
  const [cwdError, setCwdError] = useState(false);

  const dir = value.endsWith('/') ? value.slice(0, -1) : parentOf(value);
  useEffect(() => {
    let live = true;
    // Completion is best-effort: a denied or missing directory just offers nothing.
    listDir(dir || '~').then(
      (l) => live && setEntries(l.entries),
      () => live && setEntries([]),
    );
    return () => {
      live = false;
    };
  }, [dir, listDir]);
  useEffect(() => {
    if (!browse) return;
    let live = true;
    setCwdError(false);
    listDir(cwd).then(
      (l) => {
        if (!live) return;
        setCwdEntries(l.entries);
        if (l.path !== cwd) setCwd(l.path);
      },
      () => {
        if (!live) return;
        setCwdEntries([]);
        setCwdError(true);
      },
    );
    return () => {
      live = false;
    };
  }, [browse, cwd, listDir]);

  const items = useMemo(() => {
    const all = [
      ...recent.map((p) => ({ path: p, recent: true })),
      ...entries.map((e) => ({ ...e, recent: false })),
    ];
    const seen = new Set<string>();
    return all.filter((x) => {
      if (seen.has(x.path)) return false;
      seen.add(x.path);
      return x.path.startsWith(value) || !value;
    });
  }, [recent, entries, value]);
  const gitPaths = new Set([...entries, ...cwdEntries].filter((e) => e.git).map((e) => e.path));
  const crumbs = cwd.split('/').map((_, i, arr) => arr.slice(0, i + 1).join('/'));

  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <ComboBox
        inputValue={value}
        onInputChange={onChange}
        allowsCustomValue
        menuTrigger="focus"
        onSelectionChange={(k) => k && onChange(String(k))}
        className="flex flex-col gap-1.5"
      >
        <Label className={labelClass}>{label}</Label>
        <div className="flex items-center gap-2">
          <div className="relative flex min-w-0 flex-1 items-center">
            <FolderSimple
              size={18}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 text-ink-2"
            />
            <Input
              className={cx(inputShell, 'h-12 pr-3 pl-10 font-mono')}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {gitPaths.has(value) && (
              <span className="absolute right-3 inline-flex items-center gap-1 type-meta text-ink-2">
                <GitBranch size={14} aria-hidden="true" /> git
              </span>
            )}
          </div>
          {/* Clear ComboBox's ButtonContext so Browse isn't treated as the "Show suggestions" trigger. */}
          <ButtonContext.Provider value={null}>
            <Button
              variant="secondary"
              onPress={() => {
                setCwd(value.startsWith('~') || value.startsWith('/') ? dir || '~' : '~');
                setBrowse(true);
              }}
            >
              Browse
            </Button>
          </ButtonContext.Provider>
        </div>
        {description && (
          <Text slot="description" className={descriptionClass}>
            {description}
          </Text>
        )}
        <Popover className="w-[var(--trigger-width)] rounded-lg border border-line bg-surface shadow-pop outline-none">
          <ListBox items={items} className="max-h-72 overflow-y-auto p-1 outline-none">
            {(it) => (
              <ListBoxItem
                id={it.path}
                textValue={it.path}
                className="flex min-h-11 items-center gap-2 rounded-md px-3 type-meta text-ink outline-none data-[focused]:bg-sunken"
              >
                <FolderSimple size={16} aria-hidden="true" className="text-ink-2" />
                <span className="flex-1 truncate">{it.path}</span>
                {it.recent && <span className="type-micro text-ink-3">recent</span>}
                {(it as DirEntry).git && <GitBranch size={14} aria-label="git repository" />}
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
      </ComboBox>
      <Sheet
        isOpen={browse}
        onOpenChange={setBrowse}
        title="Choose a folder"
        subtitle="Only folders under your home directory"
        footer={
          <Button
            variant="primary"
            fullWidth
            onPress={() => {
              onChange(cwd);
              setBrowse(false);
            }}
          >
            Use {cwd}
          </Button>
        }
      >
        <nav aria-label="Folder path" className="mb-2 flex flex-wrap items-center gap-1 type-meta">
          {crumbs.map((c, i) => (
            <span key={c} className="inline-flex items-center gap-1">
              {i > 0 && <CaretRight size={12} aria-hidden="true" className="text-ink-3" />}
              <RACButton
                onPress={() => setCwd(c)}
                className="min-h-11 rounded-sm px-1.5 text-ink data-[hovered]:underline"
                aria-current={c === cwd ? 'location' : undefined}
              >
                {c.split('/').pop()}
              </RACButton>
            </span>
          ))}
        </nav>
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {cwdError && (
            <li className="px-4 py-3 type-body-sm text-ink-2">This folder can’t be opened from here.</li>
          )}
          {!cwdError && cwdEntries.length === 0 && (
            <li className="px-4 py-3 type-body-sm text-ink-2">No folders here.</li>
          )}
          {cwdEntries.map((e) => (
            <li key={e.path}>
              <RACButton
                onPress={() => setCwd(e.path)}
                className="flex min-h-12 w-full items-center gap-3 px-4 text-left data-[hovered]:bg-sunken"
              >
                <FolderSimple size={18} aria-hidden="true" className="text-ink-2" />
                <span className="flex-1 type-meta text-ink">{e.path.split('/').pop()}</span>
                {e.git && (
                  <span className="inline-flex items-center gap-1 type-meta text-ink-2">
                    <GitBranch size={14} aria-hidden="true" /> git
                  </span>
                )}
                <CaretRight size={14} aria-hidden="true" className="text-ink-3" />
              </RACButton>
            </li>
          ))}
        </ul>
      </Sheet>
    </div>
  );
};
