package com.syokai.syokcode;

import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;

public final class OpenChatAction extends AnAction {
    @Override public void actionPerformed(@NotNull AnActionEvent e) { Project p = e.getProject(); if (p != null) SyokRunner.run(p, null); }
    @Override public void update(@NotNull AnActionEvent e) { e.getPresentation().setEnabled(e.getProject() != null); }
}
