import { describe, expect, it } from 'vitest';
import { classify } from '../../src/desktop/runKind';

describe('classify', () => {
  const cases: Array<[string, 'sql' | 'cl' | 'qsh' | 'pase', string]> = [
    ['select * from qiws.qcustcdt', 'sql', 'select * from qiws.qcustcdt'],
    ['  SELECT 1 FROM sysibm.sysdummy1;', 'sql', 'SELECT 1 FROM sysibm.sysdummy1;'],
    ['-- a comment\nselect 1', 'sql', '-- a comment\nselect 1'],
    ['/* block */ WITH t AS (SELECT 1) SELECT * FROM t', 'sql', '/* block */ WITH t AS (SELECT 1) SELECT * FROM t'],
    ['(select 1) union (select 2)', 'sql', '(select 1) union (select 2)'],
    ['VALUES CURRENT TIMESTAMP', 'sql', 'VALUES CURRENT TIMESTAMP'],
    ['insert into x values (1)', 'sql', 'insert into x values (1)'],
    ['CREATE TABLE QTEMP.T (A INT)', 'sql', 'CREATE TABLE QTEMP.T (A INT)'],
    ['SET CURRENT SCHEMA = QGPL', 'sql', 'SET CURRENT SCHEMA = QGPL'],
    ["CALL QSYS2.QCMDEXC('DSPLIBL')", 'sql', "CALL QSYS2.QCMDEXC('DSPLIBL')"],
    ["CALL MYLIB.MYPROC(1, 'x')", 'sql', "CALL MYLIB.MYPROC(1, 'x')"],
    ['CALL PGM(QGPL/HELLO)', 'cl', 'CALL PGM(QGPL/HELLO)'],
    ['CALL HELLO', 'cl', 'CALL HELLO'],
    ["CALL QGPL/HELLO PARM('a' 'b')", 'cl', "CALL QGPL/HELLO PARM('a' 'b')"],
    ['WRKACTJOB', 'cl', 'WRKACTJOB'],
    ['wrkactjob sbs(qinter)', 'cl', 'wrkactjob sbs(qinter)'],
    ['DSPLIBL OUTPUT(*PRINT)', 'cl', 'DSPLIBL OUTPUT(*PRINT)'],
    ['CHGCURLIB CURLIB(QGPL)', 'cl', 'CHGCURLIB CURLIB(QGPL)'],
    ["SNDMSG MSG('hi there') TOUSR(*SYSOPR)", 'cl', "SNDMSG MSG('hi there') TOUSR(*SYSOPR)"],
    ['ADDLIBLE QGPL', 'cl', 'ADDLIBLE QGPL'],
    ['MYLIB/MYCMD PARM1(X)', 'cl', 'MYLIB/MYCMD PARM1(X)'],
    ['DLYJOB 5', 'cl', 'DLYJOB 5'],
    ["QSH CMD('ls')", 'cl', "QSH CMD('ls')"],
    ['ls -l /home', 'qsh', 'ls -l /home'],
    ['/QOpenSys/pkgs/bin/python3 --version', 'pase', '/QOpenSys/pkgs/bin/python3 --version'],
    ['./run.sh', 'qsh', './run.sh'],
    ['PATH=/QOpenSys/pkgs/bin:$PATH', 'qsh', 'PATH=/QOpenSys/pkgs/bin:$PATH'],
    ['db2 "select 1 from sysibm.sysdummy1"', 'qsh', 'db2 "select 1 from sysibm.sysdummy1"'],
    ['cat /etc/hosts | grep local', 'qsh', 'cat /etc/hosts | grep local'],
    ['system "WRKACTJOB"', 'qsh', 'system "WRKACTJOB"'],
    ['CL: SELECTX', 'cl', 'SELECTX'],
    ['cl:dspjob', 'cl', 'dspjob'],
    ['QSH: WRKACTJOB', 'qsh', 'WRKACTJOB'],
    ['sh: echo hi', 'qsh', 'echo hi'],
    ['SQL: ls', 'sql', 'ls'],
    ['', 'sql', ''],
    ['-- only a comment', 'sql', '-- only a comment'],
    ['FOO BAR', 'cl', 'FOO BAR'],
    ['somethingelse x = 1', 'sql', 'somethingelse x = 1'],
    ['EXPLAIN SELECT 1', 'sql', 'EXPLAIN SELECT 1'],
    ["RUNSQL SQL('select 1') COMMIT(*NONE)", 'cl', "RUNSQL SQL('select 1') COMMIT(*NONE)"],
    ['STRSQL', 'cl', 'STRSQL'],
    ['select a||b from t', 'sql', 'select a||b from t'],
  ];
  it('tells SQL, CL and Qshell apart the way the console terminal does', () => {
    for (const [input, kind, text] of cases) {
      const got = classify(input);
      expect([input, got.kind, got.text]).toEqual([input, kind, text]);
    }
  });
  it('says why', () => {
    expect(classify('DSPLIBL').why).toBe('CL verb DSPLIBL');
    expect(classify('select 1').why).toBe('SQL keyword SELECT');
    expect(classify('ls').why).toBe('shell command ls');
    expect(classify('CL: x').why).toBe('prefix CL:');
    expect(classify('a | b').why).toBe('pipeline');
  });
});

describe('classify: PASE', () => {
  it('a PASE: prefix, a /QOpenSys path or an open-source package tool runs as PASE', () => {
    expect(classify('PASE: bash -c "echo hi"')).toEqual({ kind: 'pase', text: 'bash -c "echo hi"', why: 'prefix PASE:' });
    expect(classify('/QOpenSys/pkgs/bin/python3 --version').kind).toBe('pase');
    expect(classify('git -C /home/jsmith/app status').kind).toBe('pase');
    expect(classify('python3 -m json.tool /tmp/x.json').why).toBe('PASE command python3');
    expect(classify('yum list installed').kind).toBe('pase');
  });
  it('core utilities stay Qshell, and QSH: still wins', () => {
    expect(classify('ls -l /home').kind).toBe('qsh');
    expect(classify('openssl version').kind).toBe('qsh');
    expect(classify('QSH: git status').kind).toBe('qsh');
    expect(classify('/usr/bin/ls').kind).toBe('qsh');
  });
});
