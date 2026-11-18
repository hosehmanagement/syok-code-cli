package com.syokai.syokcode;

import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import org.jetbrains.annotations.NotNull;

public final class GiveTaskAction extends AnAction {
    @Override public void actionPerformed(@NotNull AnActionEvent e) {
        Project p = e.getProject(); if (p == null) return;
        String task = Messages.showInputDialog(p, "What should Syok Code do in this project?", "Syok Code", null);
        if (task != null && !task.trim().isEmpty()) SyokRunner.run(p, task);
    }
    @Override public void update(@NotNull AnActionEvent e) { e.getPresentation().setEnabled(e.getProject() != null); }
}
