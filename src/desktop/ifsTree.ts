/**
 * The folder tree and breadcrumb model of the IFS browser: pure data, so it can be
 * tested without a DOM. Folders are loaded lazily; a node knows whether its children
 * were listed, are being listed, or failed.
 */

export interface TreeNode {
  /** Absolute path, "/" for the root. */
  path: string;
  /** The last path segment ("/" for the root). */
  name: string;
  expanded: boolean;
  /** Sub-folders known so far: placeholders on the way to the current folder until `listed`. */
  children?: TreeNode[];
  /** True once the host listed this folder (children is then complete). */
  listed?: boolean;
  loading?: boolean;
  error?: string;
}

export interface TreeRow {
  node: TreeNode;
  depth: number;
}

export interface Crumb {
  name: string;
  path: string;
}

export const joinPath = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`);
export const parentPath = (p: string): string => (p === '/' ? '/' : p.slice(0, p.lastIndexOf('/')) || '/');

/** "/home/USER/src" -> [/, home, USER, src] with the path of each segment. */
export function crumbs(path: string): Crumb[] {
  const out: Crumb[] = [{ name: '/', path: '/' }];
  let p = '';
  for (const part of path.split('/').filter(Boolean)) {
    p += `/${part}`;
    out.push({ name: part, path: p });
  }
  return out;
}

const byName = (a: TreeNode, b: TreeNode): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

export class IfsTreeModel {
  readonly root: TreeNode = { path: '/', name: '/', expanded: true };

  find(path: string): TreeNode | undefined {
    if (path === '/') return this.root;
    let node: TreeNode = this.root;
    for (const part of path.split('/').filter(Boolean)) {
      const next = node.children?.find((c) => c.name === part);
      if (!next) return undefined;
      node = next;
    }
    return node;
  }

  /**
   * Makes sure every folder on the way to `path` exists in the tree and is expanded,
   * adding placeholders for the ones not listed yet, so the current folder can be shown
   * before its parents were listed. Returns the node of `path`.
   */
  ensurePath(path: string): TreeNode {
    let node: TreeNode = this.root;
    let p = '';
    for (const part of path.split('/').filter(Boolean)) {
      p += `/${part}`;
      node.expanded = true;
      let next = node.children?.find((c) => c.name === part);
      if (!next) {
        next = { path: p, name: part, expanded: false };
        node.children = [...(node.children ?? []), next].sort(byName);
      }
      node = next;
    }
    return node;
  }

  /** Records the sub-folders of a listed folder, keeping the state of the ones already known. */
  setChildren(path: string, names: string[]): TreeNode {
    const node = this.ensurePath(path);
    const known = new Map((node.children ?? []).map((c) => [c.name, c]));
    node.children = names.map((n) => known.get(n) ?? { path: joinPath(path, n), name: n, expanded: false }).sort(byName);
    node.listed = true;
    node.loading = false;
    node.error = undefined;
    return node;
  }

  toggle(path: string): TreeNode | undefined {
    const node = this.find(path);
    if (node) node.expanded = !node.expanded;
    return node;
  }

  /** Drops what is known under a folder (after a rename or delete), keeping the node itself. */
  forget(path: string): void {
    const node = this.find(path);
    if (node) {
      node.children = undefined;
      node.listed = false;
    }
  }

  /** The visible rows, top to bottom. */
  rows(): TreeRow[] {
    const out: TreeRow[] = [];
    const walk = (node: TreeNode, depth: number): void => {
      out.push({ node, depth });
      if (node.expanded) for (const c of node.children ?? []) walk(c, depth + 1);
    };
    walk(this.root, 0);
    return out;
  }
}

/** Whether moving `source` into `target` makes sense (not into itself, a descendant, or where it already is). */
export function canMoveInto(source: string, target: string): boolean {
  if (source === '/' || target === source) return false;
  if (parentPath(source) === target) return false;
  return !target.startsWith(`${source}/`);
}
