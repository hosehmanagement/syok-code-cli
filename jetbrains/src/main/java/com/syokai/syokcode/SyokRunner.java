package com.syokai.syokcode;

import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.SystemInfo;
import com.intellij.terminal.ui.TerminalWidget;
import org.jetbrains.plugins.terminal.TerminalToolWindowManager;

import java.nio.file.Path;

/** Starts syok in the editor's own terminal, in the project folder. */
final class SyokRunner {
    private SyokRunner() {}

    static void notify(Project project, String text, NotificationType type) {
        NotificationGroupManager.getInstance().getNotificationGroup("Syok Code").createNotification("Syok Code", text.replace("\n", "<br>"), type).notify(project);
    }

    /** task == null opens a plain chat. */
    static void run(Project project, String task) {
        boolean windows = SystemInfo.isWindows;
        SyokLogic.Found found = SyokLogic.findSyok(System.getProperty("user.home"), windows, System.getenv("PATH"), SyokLogic::fileExists);
        if (found.program == null) { notify(project, found.problem, NotificationType.WARNING); return; }
        try {
            Path file = task == null ? null : SyokLogic.writeTask(task, null);
            String command = SyokLogic.buildCommand(found.program, file == null ? null : file.toString(), windows);
            TerminalWidget widget = TerminalToolWindowManager.getInstance(project).createShellWidget(project.getBasePath(), "Syok Code", true, true);
            widget.sendCommandToExecute(command);
        } catch (Exception e) {
            notify(project, "Could not start Syok Code: " + e.getMessage(), NotificationType.ERROR);
        }
    }
}
