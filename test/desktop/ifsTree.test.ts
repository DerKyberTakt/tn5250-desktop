import { describe, expect, it } from 'vitest';
import { IfsTreeModel, filterTreeRows, pathCandidates, splitTyped, canMoveInto, crumbs, joinPath, parentPath } from '../../src/desktop/ifsTree';

describe('IFS tree model', () => {
  it('splits a path into clickable crumbs', () => {
    expect(crumbs('/')).toEqual([{ name: '/', path: '/' }]);
    expect(crumbs('/home/JSMITH/src')).toEqual([
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'JSMITH', path: '/home/JSMITH' },
      { name: 'src', path: '/home/JSMITH/src' },
    ]);
    expect(joinPath('/', 'tmp')).toBe('/tmp');
    expect(joinPath('/tmp', 'a')).toBe('/tmp/a');
    expect(parentPath('/tmp/a')).toBe('/tmp');
    expect(parentPath('/tmp')).toBe('/');
    expect(parentPath('/')).toBe('/');
  });

  it('builds placeholders down to the current folder and fills them when listed', () => {
    const m = new IfsTreeModel();
    const node = m.ensurePath('/home/JSMITH');
    expect(node.path).toBe('/home/JSMITH');
    expect(m.root.expanded).toBe(true);
    expect(m.find('/home')?.expanded).toBe(true);
    expect(m.find('/home')?.children?.map((c) => c.name)).toEqual(['JSMITH']);
    // Listing the root keeps the JSMITH placeholder under home and sorts folders by name.
    m.setChildren('/', ['tmp', 'home', 'QSYS.LIB']);
    expect(m.root.children?.map((c) => c.name)).toEqual(['home', 'QSYS.LIB', 'tmp']);
    expect(m.find('/home/JSMITH')).toBeDefined();
    m.setChildren('/home/JSMITH', ['b', 'a']);
    expect(m.find('/home/JSMITH')?.children?.map((c) => c.path)).toEqual(['/home/JSMITH/a', '/home/JSMITH/b']);
  });

  it('lists only the visible rows, expanded nodes first to last', () => {
    const m = new IfsTreeModel();
    m.setChildren('/', ['home', 'tmp']);
    m.setChildren('/home', ['JSMITH']);
    m.find('/home')!.expanded = true;
    expect(m.rows().map((r) => `${r.depth}:${r.node.path}`)).toEqual(['0:/', '1:/home', '2:/home/JSMITH', '1:/tmp']);
    m.toggle('/home');
    expect(m.rows().map((r) => r.node.path)).toEqual(['/', '/home', '/tmp']);
    m.forget('/home');
    expect(m.find('/home')?.children).toBeUndefined();
    expect(m.find('/home/JSMITH')).toBeUndefined();
  });

  it('refuses moves into itself, a descendant, or the folder it is already in', () => {
    expect(canMoveInto('/home/a', '/tmp')).toBe(true);
    expect(canMoveInto('/home/a', '/home')).toBe(false);
    expect(canMoveInto('/home/a', '/home/a')).toBe(false);
    expect(canMoveInto('/home/a', '/home/a/b')).toBe(false);
    expect(canMoveInto('/home/ab', '/home/a')).toBe(true);
    expect(canMoveInto('/', '/tmp')).toBe(false);
  });
});

describe('path completion and tree filter', () => {
  it('splits what was typed into the folder to list and the part after its last slash', () => {
    expect(splitTyped('/home/JS')).toEqual({ dir: '/home', partial: 'JS' });
    expect(splitTyped('/home/')).toEqual({ dir: '/home', partial: '' });
    expect(splitTyped('/h')).toEqual({ dir: '/', partial: 'h' });
    expect(splitTyped('x')).toEqual({ dir: '/', partial: 'x' });
  });

  it('offers the names that start with the part typed, folders first, and the prefix they share', () => {
    const names = [
      { name: 'readme.txt', dir: false },
      { name: 'JSMITH', dir: true },
      { name: 'jdoe', dir: true },
      { name: 'Jsmith.bak', dir: false },
    ];
    expect(pathCandidates(names, 'j')).toEqual({ names: [{ name: 'jdoe', dir: true }, { name: 'JSMITH', dir: true }, { name: 'Jsmith.bak', dir: false }], common: 'j' });
    expect(pathCandidates(names, 'js')).toEqual({ names: [{ name: 'JSMITH', dir: true }, { name: 'Jsmith.bak', dir: false }], common: 'JSMITH' });
    expect(pathCandidates(names, 'JSMITH.')).toEqual({ names: [{ name: 'Jsmith.bak', dir: false }], common: 'Jsmith.bak' });
    expect(pathCandidates(names, 'zz')).toEqual({ names: [], common: 'zz' });
    expect(pathCandidates(names, '', 2).names).toHaveLength(2);
  });

  it('keeps a matching folder and every folder above it', () => {
    const t = new IfsTreeModel();
    t.setChildren('/', ['home', 'tmp']);
    t.setChildren('/home', ['JSMITH']);
    t.setChildren('/home/JSMITH', ['src', 'docs']);
    t.find('/home/JSMITH')!.expanded = true;
    const paths = (rows: ReturnType<typeof t.rows>): string[] => rows.map((r) => r.node.path);
    expect(paths(filterTreeRows(t.rows(), 'doc'))).toEqual(['/', '/home', '/home/JSMITH', '/home/JSMITH/docs']);
    expect(paths(filterTreeRows(t.rows(), 'TMP'))).toEqual(['/', '/tmp']);
    expect(paths(filterTreeRows(t.rows(), ''))).toEqual(paths(t.rows()));
    expect(paths(filterTreeRows(t.rows(), 'nothing'))).toEqual([]);
  });
});
