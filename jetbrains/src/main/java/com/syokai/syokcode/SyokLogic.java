package com.syokai.syokcode;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.function.Predicate;

/** Everything that does not need the editor, so it can be tested without one. */
public final class SyokLogic {
    private SyokLogic() {}

    /** What was found: the word to type in the terminal, or null with the reason. */
    public static final class Found {
        public final String program; public final String problem;
        Found(String program, String problem) { this.program = program; this.problem = problem; }
    }

    /**
     * Where the syok program is. It is typed into the user's own shell, so on Windows only the plain word "syok" is used
     * (it must be on the PATH): PowerShell and the Command Prompt start a program given by its full path in different ways.
     */
    public static Found findSyok(String home, boolean windows, String pathEnv, Predicate<String> exists) {
        String sep = windows ? ";" : ":"; String slash = windows ? "\\" : "/";
        String[] names = windows ? new String[] { "syok.cmd", "syok.exe", "syok.bat" } : new String[] { "syok" };
        for (String dir : (pathEnv == null ? "" : pathEnv).split(java.util.regex.Pattern.quote(sep))) {
            if (dir.isBlank()) continue; String d = dir.endsWith(slash) ? dir : dir + slash;
            for (String n : names) if (exists.test(d + n)) return new Found("syok", null);
        }
        String installed = home + slash + ".syok" + slash + "bin" + slash + (windows ? "syok.cmd" : "syok");
        if (exists.test(installed)) {
            if (windows) return new Found(null, "Syok Code is installed, but this editor was started before that and does not see it yet. Close the editor completely and open it again.");
            return new Found(quote(installed, false), null);
        }
        return new Found(null, "The Syok Code program is not installed. Install it with this one line in a terminal, then restart the editor:\n" + installLine(windows));
    }

    public static String installLine(boolean windows) {
        return windows ? "irm https://syok-ai.com/syok-code/install.ps1 | iex" : "curl -fsSL https://syok-ai.com/syok-code/install.sh | sh";
    }

    /**
     * A file path written so that every shell reads it as one word and nothing else.
     * Mac and Linux: single quotes, inside which no character has a meaning. Windows: forward slashes inside double quotes,
     * which PowerShell, the Command Prompt and Git Bash all read the same way; a path with a character that one of them
     * would still act on is refused.
     */
    public static String quote(String path, boolean windows) {
        if (path.indexOf('\n') >= 0 || path.indexOf('\r') >= 0 || path.indexOf('\0') >= 0) throw new IllegalArgumentException("The path contains a line break.");
        if (!windows) return "'" + path.replace("'", "'\\''") + "'";
        String p = path.replace('\\', '/');
        for (char c : new char[] { '"', '%', '$', '`', '^', '&', '|', '<', '>', '!', ';' }) if (p.indexOf(c) >= 0) throw new IllegalArgumentException("The temporary folder's path contains the character " + c + ", which a Windows shell would act on.");
        return "\"" + p + "\"";
    }

    /** The line typed into the terminal. The task itself is never on it: only the path of the file that holds it. */
    public static String buildCommand(String program, String taskFile, boolean windows) {
        if (taskFile == null) return program;
        return program + " --task-file " + quote(taskFile, windows) + " --stay";
    }

    /** A question about selected code, with where the code is. */
    public static String selectionTask(String question, String file, int startLine, int endLine, String text) {
        String q = question == null ? "" : question.trim(); if (q.isEmpty()) throw new IllegalArgumentException("The question is empty.");
        if (text == null || text.trim().isEmpty()) throw new IllegalArgumentException("No code is selected.");
        String cut = text.length() > 12000 ? text.substring(0, 12000) + "\n...[the rest of the selection was left out]" : text;
        return q + "\n\nThis is about " + file + ", lines " + startLine + "-" + endLine + ":\n```\n" + cut + "\n```";
    }

    /** Writes the task to a new private file and returns its path. The syok program removes the file once it has read it. */
    public static Path writeTask(String task, Path tmp) throws IOException {
        String t = task == null ? "" : task.trim(); if (t.isEmpty()) throw new IllegalArgumentException("The task is empty.");
        Path dir = tmp == null ? Files.createTempDirectory("syok-task-") : Files.createTempDirectory(tmp, "syok-task-");
        Path file = dir.resolve("task.txt"); Files.write(file, t.getBytes(StandardCharsets.UTF_8));
        try { Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------")); Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("rwx------")); } catch (UnsupportedOperationException ignored) { /* Windows: the temporary folder is private to the user already */ }
        return file;
    }

    static boolean fileExists(String p) { return new File(p).isFile(); }
}
