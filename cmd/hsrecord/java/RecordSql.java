// Development tool: runs a fixed set of read-only SQL statements with IBM's Java
// toolbox (jt400.jar, e.g. from an ACS install) through `hsrecord -proxy <host>`, so
// the proxy log holds real database host server requests and replies. It also
// writes what IBM's driver decoded (expected.json): the ground truth for the Go
// decoder's tests. It then runs a few CL commands through the remote command server
// (expected-commands.json), for the Console tab. Use PUB400.COM or a test system.
//
//   javac -cp jt400.jar RecordSql.java
//   java -cp jt400.jar;. RecordSql [expected.json]
import com.ibm.as400.access.AS400;
import com.ibm.as400.access.AS400JDBCDriver;
import com.ibm.as400.access.AS400Message;
import com.ibm.as400.access.CommandCall;
import java.io.Console;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Properties;

public class RecordSql {
    static final String[] STATEMENTS = {
        // One row with the common column types.
        "SELECT CAST('Hello' AS CHAR(10)) AS C10, CAST('abc' AS VARCHAR(20)) AS VC,"
            + " CAST(-12345.67 AS DECIMAL(9,2)) AS DEC92, CAST(98765.4321 AS NUMERIC(11,4)) AS NUM114,"
            + " CAST(42 AS SMALLINT) AS SI, CAST(-7 AS INTEGER) AS INT4, CAST(9007199254740993 AS BIGINT) AS BI,"
            + " CAST(1.5 AS REAL) AS R4, CAST(-2.25E10 AS DOUBLE) AS D8, CAST(1.23 AS DECFLOAT(16)) AS DF16,"
            + " DATE('2026-10-19') AS DT, TIME('13:45:30') AS TM, TIMESTAMP('2026-10-19-13.45.30.123456') AS TS,"
            + " CAST(NULL AS INTEGER) AS NULLINT, CAST(NULL AS VARCHAR(5)) AS NULLVC,"
            + " CAST(X'C1C2' AS BINARY(2)) AS BIN2, CAST('Omega' AS VARGRAPHIC(10) CCSID 1200) AS UNI,"
            + " CAST('x' AS CHAR(3) CCSID 65535) AS HEX3"
            + " FROM SYSIBM.SYSDUMMY1",
        // Many rows: more than one fetch block.
        "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ROW_LENGTH FROM QSYS2.SYSTABLES"
            + " WHERE TABLE_SCHEMA = 'QSYS2' ORDER BY TABLE_NAME FETCH FIRST 300 ROWS ONLY",
        // An error (SQL0204).
        "SELECT * FROM NOSUCHLIB.NOSUCHTABLE",
        // No result set, then a query that depends on it.
        "SET SCHEMA QSYS2",
        "SELECT COUNT(*) AS N FROM SYSCOLUMNS WHERE TABLE_SCHEMA = 'QSYS2' AND TABLE_NAME = 'SYSTABLES'",
        // A large character column and an empty result.
        "SELECT CAST(REPEAT('ab', 600) AS VARCHAR(1200)) AS LONGVC FROM SYSIBM.SYSDUMMY1",
        "SELECT TABLE_NAME FROM QSYS2.SYSTABLES WHERE 1 = 0",
    };

    public static void main(String[] args) throws Exception {
        String outFile = args.length > 0 ? args[0] : "expected.json";
        Console con = System.console();
        if (con == null) throw new IllegalStateException("run this in a console window");
        String user = con.readLine("PUB400 user profile: ").trim();
        char[] pw = con.readPassword("Password: ");

        AS400 sys = new AS400("localhost", user, new String(pw));
        sys.setGuiAvailable(false);
        // Service ports of hsrecord -proxy (8470+n -> 18470+n).
        sys.setServicePort(AS400.CENTRAL, 18470);
        sys.setServicePort(AS400.DATABASE, 18471);
        sys.setServicePort(AS400.DATAQUEUE, 18472);
        sys.setServicePort(AS400.FILE, 18473);
        sys.setServicePort(AS400.PRINT, 18474);
        sys.setServicePort(AS400.COMMAND, 18475);
        sys.setServicePort(AS400.SIGNON, 18476);

        Properties p = new Properties();
        p.setProperty("prompt", "false");
        p.setProperty("errors", "full");
        p.setProperty("date format", "iso");
        p.setProperty("time format", "iso");
        p.setProperty("naming", "sql");

        try (Connection c = new AS400JDBCDriver().connect(sys, p, null);
             Writer w = new OutputStreamWriter(new FileOutputStream(outFile), "UTF-8")) {
            w.write("[\n");
            for (int i = 0; i < STATEMENTS.length; i++) {
                if (i > 0) w.write(",\n");
                w.write(run(c, STATEMENTS[i]));
                System.out.println("ran: " + STATEMENTS[i].substring(0, Math.min(70, STATEMENTS[i].length())));
            }
            w.write("\n]\n");
        }
        System.out.println("expected values written to " + outFile);
        recordCommands(sys, "expected-commands.json");
    }

    // Remote command server: a command that works, one that fails, and QSH with its
    // output sent to a stream file (the Console tab reads it back over the IFS).
    static final String[] COMMANDS = {
        "CHKOBJ OBJ(QSYS/QCMDEXC) OBJTYPE(*PGM)",
        "CHKOBJ OBJ(QSYS/NOSUCHOBJ) OBJTYPE(*PGM)",
        "ADDENVVAR ENVVAR(QIBM_QSH_CMD_OUTPUT) VALUE('FILE=/tmp/tn5250-qsh-record.txt') REPLACE(*YES)",
        "QSH CMD('echo hello from qsh; uname -s')",
        "SNDPGMMSG MSG('hello from the console') TOPGMQ(*SAME)",
    };

    static void recordCommands(AS400 sys, String outFile) throws Exception {
        CommandCall cc = new CommandCall(sys);
        cc.setThreadSafe(false); // always through the remote command server
        try (Writer w = new OutputStreamWriter(new FileOutputStream(outFile), "UTF-8")) {
            w.write("[\n");
            for (int i = 0; i < COMMANDS.length; i++) {
                boolean ok = cc.run(COMMANDS[i]);
                if (i > 0) w.write(",\n");
                StringBuilder b = new StringBuilder("  {\"command\": ").append(q(COMMANDS[i])).append(", \"ok\": ").append(ok).append(", \"messages\": [");
                AS400Message[] msgs = cc.getMessageList();
                for (int m = 0; m < msgs.length; m++) {
                    if (m > 0) b.append(", ");
                    b.append("{\"id\": ").append(q(msgs[m].getID()))
                        .append(", \"type\": ").append(msgs[m].getType())
                        .append(", \"severity\": ").append(msgs[m].getSeverity())
                        .append(", \"text\": ").append(q(msgs[m].getText())).append("}");
                }
                w.write(b.append("]}").toString());
                System.out.println("ran: " + COMMANDS[i] + (ok ? "  (ok)" : "  (failed)"));
            }
            w.write("\n]\n");
        }
        System.out.println("command results written to " + outFile);
    }

    static String run(Connection c, String sql) {
        StringBuilder b = new StringBuilder("  {\"sql\": ").append(q(sql));
        try (Statement s = c.createStatement()) {
            if (s.execute(sql)) {
                try (ResultSet rs = s.getResultSet()) {
                    ResultSetMetaData md = rs.getMetaData();
                    b.append(", \"columns\": [");
                    for (int i = 1; i <= md.getColumnCount(); i++) {
                        if (i > 1) b.append(", ");
                        b.append("{\"name\": ").append(q(md.getColumnLabel(i)))
                            .append(", \"type\": ").append(q(md.getColumnTypeName(i)))
                            .append(", \"precision\": ").append(md.getPrecision(i))
                            .append(", \"scale\": ").append(md.getScale(i))
                            .append(", \"nullable\": ").append(md.isNullable(i) != ResultSetMetaData.columnNoNulls)
                            .append("}");
                    }
                    b.append("], \"rows\": [");
                    int n = 0;
                    while (rs.next()) {
                        if (n++ > 0) b.append(", ");
                        b.append("[");
                        for (int i = 1; i <= md.getColumnCount(); i++) {
                            if (i > 1) b.append(", ");
                            String v = rs.getString(i);
                            b.append(v == null ? "null" : q(v));
                        }
                        b.append("]");
                    }
                    b.append("]");
                }
            } else {
                b.append(", \"updateCount\": ").append(s.getUpdateCount());
            }
        } catch (SQLException e) {
            b.append(", \"error\": {\"sqlState\": ").append(q(e.getSQLState()))
                .append(", \"code\": ").append(e.getErrorCode())
                .append(", \"message\": ").append(q(e.getMessage())).append("}");
        }
        return b.append("}").toString();
    }

    static String q(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        for (char ch : s.toCharArray()) {
            if (ch == '"' || ch == '\\') b.append('\\').append(ch);
            else if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch));
            else b.append(ch);
        }
        return b.append('"').toString();
    }
}
