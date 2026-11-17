/**
 * Tells what kind of statement a line of a Run SQL Scripts editor is: SQL for the
 * database server, a CL command for the remote command server, or a Qshell / PASE
 * command line. The rules mirror the console terminal's (tn5250-tui `runscript.Classify`):
 *
 * - an explicit `SQL:`, `CL:`, `QSH:` (`SH:`) or `PASE:` prefix always wins and is stripped;
 * - an SQL keyword (SELECT, WITH, INSERT, CREATE, SET, ...) is SQL;
 * - CALL is CL as `CALL PGM(...)`, `CALL NAME`, `CALL LIB/NAME PARM(...)`, else SQL;
 * - a path, a `VAR=value`, a known shell command name or a pipeline is Qshell;
 * - a CL verb (`WRKACTJOB`, `LIB/CMD`) followed by nothing or by CL parameters is CL;
 * - anything else is SQL, and the host says what it thinks.
 *
 * A misclassified line goes to the wrong interpreter and comes back as an error.
 */

export type RunKind = 'sql' | 'cl' | 'qsh' | 'pase';

export interface Classified {
  kind: RunKind;
  /** The statement without a prefix. */
  text: string;
  /** What decided the kind, for the Messages pane: "prefix CL:", "SQL keyword SELECT", "CL verb DSPLIBL", ... */
  why: string;
}

const PREFIX = /^\s*(SQL|CL|QSH|SH|PASE)\s*:\s*/i;
const COMMENTS = /^(\s|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/;
const FIRST_WORD = /^([A-Za-z0-9_$#@./~-]+)/;
const CL_SHAPE = /^([A-Z0-9$#@_]{1,10}\/)?[A-Z][A-Z0-9$#@_]{1,9}$/i;
const CL_PARM = /^\s*(\*[A-Z0-9]+|[A-Z0-9$#@_]+\s*\(|'[^']*'|&[A-Z0-9]+|[A-Z0-9$#@_./]+\s*$)/i;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CALL_CL = /^CALL\s+(PGM\s*\(|[A-Z0-9$#@_]+(\/[A-Z0-9$#@_]+)?\s*(PARM\s*\(|$))/i;

const SQL_KEYWORDS = new Set([
  'SELECT', 'VALUES', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'DECLARE', 'SET',
  'GRANT', 'REVOKE', 'COMMENT', 'LABEL', 'TRUNCATE', 'RENAME', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE',
  'LOCK', 'EXPLAIN', 'REFRESH', 'TRANSFER', 'CONNECT', 'DISCONNECT', 'PREPARE', 'EXECUTE', 'DESCRIBE', 'OPEN',
  'FETCH', 'CLOSE', 'ANALYZE', 'SIGNAL', 'RESIGNAL', 'CASE', 'IF', 'WHILE', 'FOR', 'LOOP', 'REPEAT', 'RETURN', 'GET',
  'FREE', 'HOLD', 'ALLOCATE', 'ASSOCIATE', 'ITERATE', 'LEAVE', 'GOTO',
]);

const SHELL_COMMANDS = new Set([
  'ls', 'cat', 'cd', 'pwd', 'echo', 'grep', 'egrep', 'find', 'export', 'env', 'printenv', 'head', 'tail', 'wc', 'sort',
  'uniq', 'cut', 'sed', 'awk', 'tr', 'touch', 'mkdir', 'rm', 'rmdir', 'cp', 'mv', 'chmod', 'chown', 'chgrp', 'ln', 'df',
  'du', 'ps', 'kill', 'date', 'uname', 'whoami', 'id', 'which', 'iconv', 'system', 'db2', 'java', 'javac', 'python',
  'python3', 'node', 'npm', 'git', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'jar',
  'sh', 'bash', 'ksh', 'qsh', 'test', 'true', 'false', 'sleep', 'basename', 'dirname', 'diff', 'cmp', 'file', 'less',
  'more', 'md5sum', 'sha256sum', 'openssl', 'pax', 'setccsid', 'attr', 'liblist', 'datarea', 'dataq', 'Rfile', 'rfile',
  'ulimit', 'umask', 'xargs', 'tee', 'nohup', 'perl', 'ruby', 'php', 'make', 'gcc', 'ps1', 'hostname', 'netstat', 'ping',
  'nslookup', 'dig', 'ifconfig', 'mount', 'su', 'sudo', 'exit', 'clear', 'history', 'alias', 'unset', 'source', 'yum',
  'rpm', 'pip', 'pip3',
]);

/**
 * Tools that live in /QOpenSys/pkgs/bin (the open-source packages) or need the PASE shell:
 * Qshell's PATH does not reach them, so a line that starts with one runs as PASE
 * (/QOpenSys/usr/bin/sh through QP2SHELL, with the packages on PATH). The core PASE
 * utilities in /QOpenSys/usr/bin (openssl, tr, printf, gzip ...) run under Qshell as well.
 */
const PASE_ONLY = new Set([
  'bash', 'zsh', 'git', 'python', 'python3', 'pip', 'pip3', 'node', 'npm', 'npx', 'yum', 'rpm', 'curl', 'wget', 'jq',
  'gcc', 'g++', 'make', 'cmake', 'perl', 'ruby', 'php', 'vim', 'nano', 'rsync', 'tmux', 'go', 'cargo', 'rustc', 'sudo',
  'htop', 'tree', 'ncdu', 'bat', 'rg', 'fd',
]);

function looksLikeSqlTail(rest: string): boolean {
  const u = ` ${rest.toUpperCase()} `;
  for (const w of [' FROM ', ' WHERE ', ' JOIN ', ' SELECT ', ' VALUES ', ' INTO ']) if (u.includes(w)) return true;
  return rest.includes(';') && !rest.includes("'");
}

export function classify(input: string): Classified {
  const m = PREFIX.exec(input);
  if (m) {
    const rest = input.slice(m[0].length).trim();
    const p = m[1]!.toUpperCase();
    if (p === 'CL') return { kind: 'cl', text: rest, why: 'prefix CL:' };
    if (p === 'QSH' || p === 'SH') return { kind: 'qsh', text: rest, why: 'prefix QSH:' };
    if (p === 'PASE') return { kind: 'pase', text: rest, why: 'prefix PASE:' };
    return { kind: 'sql', text: rest, why: 'prefix SQL:' };
  }
  const text = input.trim();
  const body = text.replace(COMMENTS, '').trim();
  if (!body) return { kind: 'sql', text, why: 'empty' };
  const fw = FIRST_WORD.exec(body);
  if (!fw) {
    return body.startsWith('(') ? { kind: 'sql', text, why: 'SQL (parenthesised query)' } : { kind: 'sql', text, why: 'default' };
  }
  const first = fw[1]!;
  const upper = first.toUpperCase();
  const rest = body.slice(first.length).trim();
  if (first.startsWith('/QOpenSys/')) return { kind: 'pase', text, why: `PASE path ${first}` };
  if (first.startsWith('/') || first.startsWith('./') || first.startsWith('~') || first.startsWith('../')) {
    return { kind: 'qsh', text, why: `shell path ${first}` };
  }
  if (PASE_ONLY.has(first)) return { kind: 'pase', text, why: `PASE command ${first}` };
  if (ASSIGN.test(body) && !SQL_KEYWORDS.has(upper)) return { kind: 'qsh', text, why: 'shell assignment' };
  if (upper === 'CALL') {
    return CALL_CL.test(body) ? { kind: 'cl', text, why: 'CL CALL' } : { kind: 'sql', text, why: 'SQL CALL' };
  }
  if (SQL_KEYWORDS.has(upper)) return { kind: 'sql', text, why: `SQL keyword ${upper}` };
  if (SHELL_COMMANDS.has(first) || (SHELL_COMMANDS.has(first.toLowerCase()) && first === first.toLowerCase())) {
    return { kind: 'qsh', text, why: `shell command ${first}` };
  }
  if (CL_SHAPE.test(first) && (rest === '' || CL_PARM.test(rest)) && !looksLikeSqlTail(rest)) {
    return { kind: 'cl', text, why: `CL verb ${upper}` };
  }
  if (body.includes('|') && !body.toUpperCase().includes('||')) return { kind: 'qsh', text, why: 'pipeline' };
  return { kind: 'sql', text, why: 'default' };
}
