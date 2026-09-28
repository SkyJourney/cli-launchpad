import { useMutation, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useDirectories } from "../hooks/queries";
import { qk } from "../lib/queryKeys";
import { addDirectory, updateDirectory } from "../lib/tauri";
import { useAppStore } from "../store/appStore";
import { FormField, TextArea, TextInput } from "./FormControls";

export function ProjectMaintenanceDialog() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const dialog = useAppStore((state) => state.projectDialog);
  const setProjectDialog = useAppStore((state) => state.setProjectDialog);
  const openDirectory = useAppStore((state) => state.openDirectory);
  const { data: directories } = useDirectories();
  const directory =
    dialog?.mode === "edit"
      ? directories?.find((item) => item.id === dialog.directoryId)
      : undefined;
  const [name, setName] = useState(directory?.name ?? "");
  const [path, setPath] = useState(directory?.path ?? "");
  const [note, setNote] = useState(directory?.note ?? "");
  const [folderError, setFolderError] = useState<string | null>(null);
  const initializedDirectoryId = useRef(directory?.id ?? null);

  useEffect(() => {
    if (
      dialog?.mode !== "edit" ||
      !directory ||
      initializedDirectoryId.current === directory.id
    ) {
      return;
    }
    initializedDirectoryId.current = directory.id;
    setName(directory.name);
    setPath(directory.path);
    setNote(directory.note ?? "");
  }, [dialog, directory]);

  const mutation = useMutation({
    mutationFn: async () => {
      const trimmedName = name.trim();
      const trimmedNote = note.trim() || null;
      if (dialog?.mode === "edit") {
        await updateDirectory(dialog.directoryId, trimmedName, trimmedNote);
        return null;
      }
      return addDirectory(trimmedName, path.trim(), trimmedNote);
    },
    onSuccess: async (createdDirectory) => {
      await queryClient.invalidateQueries({ queryKey: qk.directories() });
      setProjectDialog(null);
      if (createdDirectory) openDirectory(createdDirectory.id);
    },
  });

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !mutation.isPending) {
        setProjectDialog(null);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mutation.isPending, setProjectDialog]);

  const pickFolder = async () => {
    setFolderError(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("projects.chooseDirectory"),
      });
      if (typeof selected !== "string") return;
      setPath(selected);
      if (!name.trim()) {
        setName(selected.split(/[\\/]/).filter(Boolean).pop() ?? "");
      }
    } catch (error) {
      setFolderError(t("projectDialog.chooseFailed", { error: String(error) }));
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim() || (dialog?.mode === "add" && !path.trim())) return;
    mutation.mutate();
  };

  const editing = dialog?.mode === "edit";
  const title = editing
    ? t("projectDialog.editTitle")
    : t("projectDialog.addTitle");

  return (
    <div className="project-dialog-backdrop">
      <section
        className="project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-dialog-title"
      >
        <header className="project-dialog-header">
          <h2 id="project-dialog-title">{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={t("common.cancel")}
            title={t("common.cancel")}
            disabled={mutation.isPending}
            onClick={() => setProjectDialog(null)}
          >
            <X size={18} />
          </button>
        </header>
        {editing && !directory ? (
          <p className="muted">{t("projectDialog.loading")}</p>
        ) : (
          <form className="project-dialog-form" onSubmit={submit}>
            <FormField id="project-name" label={t("projectDialog.name")}>
              <TextInput
                id="project-name"
                autoFocus
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("projects.namePlaceholder")}
                required
              />
            </FormField>
            <FormField
              id="project-directory"
              label={t("projectDialog.directory")}
            >
              <div className="project-dialog-path-row">
                <TextInput
                  id="project-directory"
                  value={path}
                  readOnly
                  placeholder={t("projects.pathPlaceholder")}
                  required
                />
                {!editing && (
                  <button
                    type="button"
                    className="ghost-button project-dialog-choose-button"
                    onClick={() => void pickFolder()}
                  >
                    <FolderOpen size={15} />
                    {t("projectDialog.chooseDirectory")}
                  </button>
                )}
              </div>
            </FormField>
            {folderError && (
              <p className="error" role="alert">
                {folderError}
              </p>
            )}
            <FormField id="project-note" label={t("projectDialog.note")}>
              <TextArea
                id="project-note"
                value={note}
                rows={3}
                maxLength={500}
                onChange={(event) => setNote(event.target.value)}
                placeholder={t("projectDialog.notePlaceholder")}
              />
            </FormField>
            {mutation.isError && (
              <p className="error" role="alert">
                {t("projectDialog.saveFailed", {
                  error: String(mutation.error),
                })}
              </p>
            )}
            <div className="project-dialog-actions">
              <button
                type="button"
                className="ghost-button"
                disabled={mutation.isPending}
                onClick={() => setProjectDialog(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={
                  mutation.isPending ||
                  !name.trim() ||
                  (!editing && !path.trim())
                }
              >
                {mutation.isPending
                  ? t("projectDialog.saving")
                  : t("common.save")}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
