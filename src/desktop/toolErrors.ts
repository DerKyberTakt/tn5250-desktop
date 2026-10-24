import { friendlyNetError } from '../shared/netErrors';

/** The host-server tools; each has its own server job and exit point on the IBM i. */
export type Tool = 'IFS' | 'SQL' | 'CL' | 'QSH';

export interface ToolError {
  /** One plain sentence for the user. */
  message: string;
  /** What to ask the administrator for, when there is something to ask. */
  hint?: string;
  /** The original message, for "Copy details". */
  raw: string;
  kind: 'network' | 'refused' | 'password' | 'authority' | 'missing' | 'other';
}

const SERVER: Record<Tool, { name: string; exit: string }> = {
  IFS: { name: 'file server (QPWFSERVSO)', exit: 'QIBM_QPWFS_FILE_SERV' },
  SQL: { name: 'database server (QZDASOINIT)', exit: 'QIBM_QZDA_INIT' },
  CL: { name: 'remote command server (QZRCSRVS)', exit: 'QIBM_QZRC_RMT' },
  QSH: { name: 'remote command server (QZRCSRVS)', exit: 'QIBM_QZRC_RMT' },
};

const AUTHORITY_IDS = /\b(CPF2207|CPF9802|CPF9820|CPF4236|CPF2189|CPF2204|CPD0032|SQL0551|SQL0552|SQL0204|SQL0104)\b/i;
const NOT_FOUND_IDS = /\b(CPF2204|SQL0204)\b/i;

/**
 * Turns a raw error from a host-server tool into what the user can act on: whether
 * the host servers are reachable, whether the sign-on was refused (and by what),
 * whether it is an authority problem, or whether QSH is missing, with the message id
 * kept for the administrator.
 */
export function explainToolError(tool: Tool, host: string, raw: string): ToolError {
  const r = raw.trim();
  const m = r.toLowerCase();
  const where = host || 'the host';

  if (/sign-on refused by an exit program/.test(m)) {
    return {
      kind: 'refused',
      message: `${tool} was refused by an exit program on ${where}.`,
      hint: `Ask your administrator to allow your user profile for the ${SERVER[tool].name}, exit point ${SERVER[tool].exit}.`,
      raw: r,
    };
  }
  if (/sign-on refused: (the password|the user profile)/.test(m)) {
    return {
      kind: 'password',
      message: `Sign-on to ${where} failed: ${r.replace(/^sign-on refused:\s*/i, '')}`,
      hint: 'Check the saved password (Tools > Saved Passwords) or sign on with a different user profile.',
      raw: r,
    };
  }
  if (/sign-on refused/.test(m)) {
    return { kind: 'refused', message: `${tool}: ${r}`, hint: `Ask your administrator about the ${SERVER[tool].name} on ${where}.`, raw: r };
  }
  if (tool === 'QSH' && /(qsh.*(not found|cannot be found|no such)|cpd0030|cpf0006|option 30|qshell)/.test(m)) {
    return {
      kind: 'missing',
      message: `QSH is not installed on ${where}, or you cannot run it.`,
      hint: 'Qshell is 5770-SS1 option 30; your user profile needs *USE on QSYS/QSH.',
      raw: r,
    };
  }
  const id = AUTHORITY_IDS.exec(r)?.[1]?.toUpperCase();
  if (id && !NOT_FOUND_IDS.test(id) && /(not authorized|authority|permission denied|user not authorized)/.test(m)) {
    return {
      kind: 'authority',
      message: `You are not authorized to do that on ${where} (${id}).`,
      hint: `Ask your administrator for the authority named in ${id}.`,
      raw: r,
    };
  }
  if (/(not authorized|authority|permission denied)/.test(m)) {
    return { kind: 'authority', message: `You are not authorized to do that on ${where}.`, hint: 'Ask your administrator for authority to the object or command named in the details.', raw: r };
  }
  const net = friendlyNetError(r, where, 0, 'the host servers are started (STRHOSTSVR *ALL)');
  if (net !== r) {
    return {
      kind: 'network',
      message: net,
      hint: 'If the servers are started, a firewall or VPN may be blocking ports 449 and 8470-8476 (9470-9476 with TLS).',
      raw: r,
    };
  }
  return { kind: 'other', message: r, raw: r };
}
