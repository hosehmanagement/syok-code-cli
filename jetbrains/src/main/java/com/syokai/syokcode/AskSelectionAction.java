package com.syokai.syokcode;

import com.intellij.notification.NotificationType;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;

public final class AskSelectionAction extends AnAction {
    @Override public @NotNull ActionUpdateThread getActionUpdateThread() { return ActionUpdateThread.EDT; }

    @Override public void update(@NotNull AnActionEvent e) {
        Editor ed = e.getData(CommonDataKeys.EDITOR);
        e.getPresentation().setEnabledAndVisible(e.getProject() != null && ed != null && ed.getSelectionModel().hasSelection());
    }

    @Override public void actionPerformed(@NotNull AnActionEvent e) {
        Project p = e.getProject(); Editor ed = e.getData(CommonDataKeys.EDITOR); if (p == null || ed == null) return;
        SelectionModel sel = ed.getSelectionModel(); String text = sel.getSelectedText(); if (text == null || text.trim().isEmpty()) return;
        String question = Messages.showInputDialog(p, "What do you want to know or change about the selected code?", "Syok Code", null);
        if (question == null || question.trim().isEmpty()) return;
        Document doc = ed.getDocument(); VirtualFile vf = e.getData(CommonDataKeys.VIRTUAL_FILE);
        String base = p.getBasePath(); String path = vf == null ? "the open file" : vf.getPath();
        if (base != null && path.startsWith(base + "/")) path = path.substring(base.length() + 1);
        int start = doc.getLineNumber(sel.getSelectionStart()) + 1, end = doc.getLineNumber(Math.max(sel.getSelectionStart(), sel.getSelectionEnd() - 1)) + 1;
        try { SyokRunner.run(p, SyokLogic.selectionTask(question, path, start, end, text)); }
        catch (IllegalArgumentException ex) { SyokRunner.notify(p, ex.getMessage(), NotificationType.WARNING); }
    }
}
