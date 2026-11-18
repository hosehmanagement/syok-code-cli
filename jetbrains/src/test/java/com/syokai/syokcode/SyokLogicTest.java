package com.syokai.syokcode;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;

import static org.junit.Assert.*;

public class SyokLogicTest {
    @Test public void foundOnThePathIsThePlainWord() {
        SyokLogic.Found f = SyokLogic.findSyok("/home/me", false, "/usr/bin:/home/me/.syok/bin", Set.of("/home/me/.syok/bin/syok")::contains);
        assertEquals("syok", f.program); assertNull(f.problem);
        SyokLogic.Found w = SyokLogic.findSyok("C:\\Users\\me", true, "C:\\Windows;C:\\Users\\me\\.syok\\bin\\", Set.of("C:\\Users\\me\\.syok\\bin\\syok.cmd")::contains);
        assertEquals("syok", w.program);
    }

    @Test public void installedButNotOnThePath() {
        SyokLogic.Found f = SyokLogic.findSyok("/home/jim lau", false, "/usr/bin", Set.of("/home/jim lau/.syok/bin/syok")::contains);
        assertEquals("'/home/jim lau/.syok/bin/syok'", f.program); // one word for the shell, spaces and all
        SyokLogic.Found w = SyokLogic.findSyok("C:\\Users\\me", true, "C:\\Windows", Set.of("C:\\Users\\me\\.syok\\bin\\syok.cmd")::contains);
        assertNull(w.program); assertTrue(w.problem.contains("Close the editor completely and open it again"));
    }

    @Test public void notInstalledShowsTheInstallLine() {
        SyokLogic.Found f = SyokLogic.findSyok("/home/me", false, "/usr/bin", p -> false);
        assertNull(f.program); assertTrue(f.problem.contains("curl -fsSL https://syok-ai.com/syok-code/install.sh | sh"));
        SyokLogic.Found w = SyokLogic.findSyok("C:\\Users\\me", true, null, p -> false);
        assertTrue(w.problem.contains("irm https://syok-ai.com/syok-code/install.ps1 | iex"));
    }

    @Test public void aPathIsAlwaysOneWordAndNothingElse() {
        assertEquals("'/tmp/syok-task-1/task.txt'", SyokLogic.quote("/tmp/syok-task-1/task.txt", false));
        assertEquals("'/tmp/it'\\''s; rm -rf ~ $(x) `y`/task.txt'", SyokLogic.quote("/tmp/it's; rm -rf ~ $(x) `y`/task.txt", false));
        assertEquals("\"C:/Users/Jim Lau/AppData/Local/Temp/syok-task-1/task.txt\"", SyokLogic.quote("C:\\Users\\Jim Lau\\AppData\\Local\\Temp\\syok-task-1\\task.txt", true));
        for (String bad : new String[] { "C:\\a%b\\t.txt", "C:\\a&b\\t.txt", "C:\\a\"b\\t.txt", "C:\\a$b\\t.txt", "C:\\a`b\\t.txt", "C:\\a;b\\t.txt" }) {
            try { SyokLogic.quote(bad, true); fail("accepted " + bad); } catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("Windows shell")); }
        }
        try { SyokLogic.quote("/tmp/a\nb", false); fail(); } catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("line break")); }
    }

    @Test public void theTaskIsNeverOnTheCommandLine() {
        assertEquals("syok", SyokLogic.buildCommand("syok", null, false));
        assertEquals("syok --task-file '/tmp/syok-task-9/task.txt' --stay", SyokLogic.buildCommand("syok", "/tmp/syok-task-9/task.txt", false));
        assertEquals("syok --task-file \"C:/T/syok-task-9/task.txt\" --stay", SyokLogic.buildCommand("syok", "C:\\T\\syok-task-9\\task.txt", true));
    }

    @Test public void theTaskFileHoldsTheTaskExactly() throws Exception {
        Path tmp = Files.createTempDirectory("syok-logic-test-");
        String task = "Fix the bug in a.js; then run `npm test` && echo \"done\" $HOME 'x' %PATH%\nsecond line";
        Path f = SyokLogic.writeTask("  " + task + "  ", tmp);
        assertEquals(task, new String(Files.readAllBytes(f), StandardCharsets.UTF_8));
        assertTrue(f.getParent().getFileName().toString().startsWith("syok-task-")); assertEquals("task.txt", f.getFileName().toString());
        try { SyokLogic.writeTask("   ", tmp); fail(); } catch (IllegalArgumentException expected) { assertEquals("The task is empty.", expected.getMessage()); }
    }

    @Test public void aQuestionAboutSelectedCodeSaysWhereTheCodeIs() {
        String t = SyokLogic.selectionTask(" Why is this slow? ", "src/app.py", 10, 12, "for x in y:\n    go(x)\n");
        assertEquals("Why is this slow?\n\nThis is about src/app.py, lines 10-12:\n```\nfor x in y:\n    go(x)\n\n```", t);
        String big = SyokLogic.selectionTask("q", "f", 1, 2, "a".repeat(13000));
        assertTrue(big.contains("[the rest of the selection was left out]")); assertTrue(big.length() < 12200);
        try { SyokLogic.selectionTask("", "f", 1, 1, "x"); fail(); } catch (IllegalArgumentException expected) { assertEquals("The question is empty.", expected.getMessage()); }
        try { SyokLogic.selectionTask("q", "f", 1, 1, "  "); fail(); } catch (IllegalArgumentException expected) { assertEquals("No code is selected.", expected.getMessage()); }
    }
}
