import React, { useEffect, useRef, useState } from 'react';
import { Copy, Download, FileUp, FolderOpen, Plus, ShieldCheck, Star, Trash2, X } from 'lucide-react';
import { buildFullStudioBackup, restoreFullStudioBackup } from '../storage/backupVault';
import { CustomTemplatePreset, getDefaultCustomPreset } from '../storage/customPresets';
import {
  ProjectSummary,
  deepCloneProject,
  deepCloneValue,
  deleteProjectFromStore,
  listProjectsFromStore,
  loadProjectById,
  saveProjectToStore,
} from '../storage/projectStore';
import { DEFAULT_TEMPLATE, QuizProject, createDefaultProject, createUniqueId } from '../types/quiz';
import { saveOrDownloadBlob } from '../utils/nativeDownload';

interface ProjectsModalProps {
  isOpen: boolean;
  currentProject: QuizProject;
  onClose: () => void;
  onBeforeSwitchProject?: () => Promise<void>;
  onSelectProject: (proj: QuizProject) => void;
  onRenameCurrent: (name: string) => void;
}

export const ProjectsModal: React.FC<ProjectsModalProps> = ({
  isOpen,
  currentProject,
  onClose,
  onBeforeSwitchProject,
  onSelectProject,
  onRenameCurrent,
}) => {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [editingName, setEditingName] = useState(currentProject.name);
  const [defaultPreset, setDefaultPreset] = useState<CustomTemplatePreset | null>(null);
  const [backupNotice, setBackupNotice] = useState<string>('');
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const restoreInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setEditingName(currentProject.name);
    setBackupNotice('');
    setConfirmDeleteId(null);
    void getDefaultCustomPreset().then(setDefaultPreset);
    const flushAndList = async () => {
      if (onBeforeSwitchProject) {
        await onBeforeSwitchProject();
      } else {
        await saveProjectToStore(currentProject);
      }
      const list = await listProjectsFromStore();
      setProjects(list);
    };
    void flushAndList();
  }, [isOpen]);

  if (!isOpen) return null;

  const flushOutgoing = async () => {
    if (onBeforeSwitchProject) {
      await onBeforeSwitchProject();
    } else {
      await saveProjectToStore(currentProject);
    }
  };

  const handleCreateNew = async () => {
    if (isSwitching) return;
    setIsSwitching(true);
    try {
      await flushOutgoing();
      const fresh = createDefaultProject();
      fresh.id = createUniqueId('proj');
      fresh.name = `مشروع جديد ${projects.length + 1}`;
      const customDef = defaultPreset ?? (await getDefaultCustomPreset());
      if (customDef) {
        fresh.template = deepCloneValue({
          ...DEFAULT_TEMPLATE,
          ...customDef.template,
        });
        if (customDef.timing) {
          fresh.timing = deepCloneValue(customDef.timing);
        }
        if (customDef.audio) {
          fresh.audio = deepCloneValue(customDef.audio);
        }
      }
      await saveProjectToStore(fresh, { setAsActive: true });
      onSelectProject(fresh);
      onClose();
    } finally {
      setIsSwitching(false);
    }
  };

  const handleDuplicateCurrent = async () => {
    if (isSwitching) return;
    setIsSwitching(true);
    try {
      await flushOutgoing();
      const cloned = deepCloneProject(currentProject, {
        newId: createUniqueId('proj'),
        newName: `${currentProject.name} (نسخة)`,
        freshSlideIds: true,
      });
      await saveProjectToStore(cloned, { setAsActive: true });
      onSelectProject(cloned);
      onClose();
    } finally {
      setIsSwitching(false);
    }
  };

  const handleOpenProject = async (id: string) => {
    if (isSwitching) return;
    if (id === currentProject.id) {
      onClose();
      return;
    }
    setIsSwitching(true);
    try {
      await flushOutgoing();
      const loaded = await loadProjectById(id);
      if (loaded) {
        onSelectProject(loaded);
        onClose();
      }
    } finally {
      setIsSwitching(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (id === currentProject.id || projects.length <= 1) return;
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setConfirmDeleteId(null);
    const next = await deleteProjectFromStore(id);
    setProjects(next);
  };

  const handleExportFullBackup = async () => {
    if (isBackingUp) return;
    setIsBackingUp(true);
    setBackupNotice('');
    try {
      const bundle = await buildFullStudioBackup(currentProject);
      const json = JSON.stringify(bundle, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const fileName = `shorts-studio-backup-${Date.now()}.json`;
      const res = await saveOrDownloadBlob(blob, fileName, 'application/json');
      if (res.ok) {
        setBackupNotice(
          `تم حفظ نسخة احتياطية شاملة (${bundle.projects.length} مشاريع و ${bundle.customPresets.length} ستايل).`
        );
      } else {
        setBackupNotice('تعذر حفظ النسخة الاحتياطية على الجهاز.');
      }
    } catch {
      setBackupNotice('حدث خطأ أثناء تجهيز النسخة الاحتياطية.');
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleRestoreFullBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsBackingUp(true);
    setBackupNotice('');
    try {
      const text = await file.text();
      const restored = await restoreFullStudioBackup(text);
      const nextList = await listProjectsFromStore();
      setProjects(nextList);
      onSelectProject(restored.activeProject);
      setBackupNotice(
        `تمت استعادة ${restored.restoredProjectsCount} مشروع و ${restored.restoredPresetsCount} ستايل بنجاح.`
      );
    } catch (err) {
      setBackupNotice(err instanceof Error ? err.message : 'تعذر قراءة ملف النسخة الاحتياطية.');
    } finally {
      setIsBackingUp(false);
      e.target.value = '';
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      dir="rtl"
    >
      <div className="w-full max-w-md rounded-2xl bg-[var(--panel)] border border-[var(--pline)] shadow-2xl overflow-hidden text-[var(--ptxt)]">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--pline)]">
          <div className="flex items-center gap-2 text-sm font-bold">
            <FolderOpen className="w-4 h-4 text-[#00B050]" />
            <span>مكتبة المشاريع المحفوظة</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-[var(--pmuted)] hover:text-[var(--ptxt)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4 max-h-[78vh] overflow-y-auto">
          <div className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#00B050]/10 border border-[#00B050]/30 text-[11px] text-[#00B050] dark:text-[#6ee7b7] font-semibold">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            <span>كل مشروع وكل سؤال محفوظان في سجل معزول تماماً لمنع التداخل أو الفقدان.</span>
          </div>

          {/* Rename Active Project */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-bold text-[var(--pmuted)]">اسم المشروع الحالي</span>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={editingName}
                onChange={(e) => {
                  const nextName = e.target.value;
                  setEditingName(nextName);
                  onRenameCurrent(nextName);
                  setProjects((prev) =>
                    prev.map((item) =>
                      item.id === currentProject.id
                        ? { ...item, name: nextName || 'مشروع بدون اسم' }
                        : item
                    )
                  );
                }}
                placeholder="اسم المشروع..."
                className="flex-1 px-3 py-2 rounded-lg bg-[var(--surface)] border border-[var(--pline)] focus:border-[#00B050] focus:outline-none text-xs"
              />
            </div>
          </div>

          {defaultPreset && (
            <div className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[var(--gold)]/10 border border-[var(--gold)]/35 text-[11px] text-[var(--gold)] font-semibold">
              <Star className="w-3.5 h-3.5 fill-current shrink-0" />
              <span>
                أي مشروع جديد سيبدأ بستايلك الافتراضي: «{defaultPreset.name}»
              </span>
            </div>
          )}

          {/* Quick Actions */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={isSwitching}
              onClick={() => void handleCreateNew()}
              className="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl bg-[#00B050] hover:bg-[#00c85b] disabled:opacity-60 text-white text-xs font-bold transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>مشروع جديد فارغ</span>
            </button>
            <button
              type="button"
              disabled={isSwitching}
              onClick={() => void handleDuplicateCurrent()}
              className="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl bg-[var(--surface)] hover:border-[var(--gold)] disabled:opacity-60 border border-[var(--pline)] text-xs font-bold transition-colors cursor-pointer"
            >
              <Copy className="w-3.5 h-3.5 text-[var(--gold)]" />
              <span>نسخ القالب كمشروع جديد</span>
            </button>
          </div>

          {/* Projects List */}
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-bold text-[var(--pmuted)]">
              جميع المشاريع ({projects.length})
            </span>

            {projects.map((p) => {
              const isActive = p.id === currentProject.id;
              const isConfirmingDelete = confirmDeleteId === p.id;
              return (
                <div
                  key={p.id}
                  className={`flex items-center justify-between gap-2 p-3 rounded-xl border transition-colors ${
                    isActive
                      ? 'bg-[#00B050]/14 border-[#00B050]'
                      : 'bg-[var(--surface)] border-[var(--pline)] hover:border-[var(--gold)]'
                  }`}
                >
                  <button
                    type="button"
                    disabled={isSwitching}
                    onClick={() => void handleOpenProject(p.id)}
                    className="flex-1 text-right min-w-0 cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold truncate">{p.name}</span>
                      {isActive && (
                        <span className="text-[10px] font-bold text-[#00B050]">(مفتوح)</span>
                      )}
                    </div>
                    <div className="text-[10px] text-[var(--pmuted)] mt-0.5 font-mono-nums">
                      {p.slideCount} أسئلة · {p.aspectRatio}
                    </div>
                  </button>

                  {!isActive && projects.length > 1 && (
                    <button
                      type="button"
                      onClick={() => void handleDelete(p.id)}
                      title={isConfirmingDelete ? 'اضغط مجدداً لتأكيد الحذف' : 'حذف المشروع'}
                      className={`px-2 py-1.5 rounded-lg text-[10px] font-bold cursor-pointer transition-colors ${
                        isConfirmingDelete
                          ? 'bg-rose-600 text-white'
                          : 'text-rose-400 hover:bg-rose-500/15'
                      }`}
                    >
                      {isConfirmingDelete ? 'تأكيد الحذف' : <Trash2 className="w-3.5 h-3.5" />}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {/* Full Studio Backup & Restore Section */}
          <div className="rounded-xl bg-[var(--surface)] border border-[var(--pline)] p-3 flex flex-col gap-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-bold text-[var(--ptxt)]">
                نسخة احتياطية شاملة (كل المشاريع والستايلات)
              </span>
              <span className="text-[10px] text-[var(--pmuted)] leading-relaxed">
                احفظ كل أعمالك في ملف واحد قبل تحديث الـ APK أو نقله لجهاز آخر، واستعدها بضغطة واحدة.
              </span>
            </div>

            <input
              ref={restoreInputRef}
              type="file"
              accept=".json,application/json"
              onChange={(e) => void handleRestoreFullBackup(e)}
              className="hidden"
            />

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={isBackingUp}
                onClick={() => void handleExportFullBackup()}
                className="flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-lg bg-[var(--panel)] border border-[var(--pline)] hover:border-[var(--gold)] disabled:opacity-60 text-[11px] font-bold transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-[var(--gold)]" />
                <span>حفظ كل شيء</span>
              </button>
              <button
                type="button"
                disabled={isBackingUp}
                onClick={() => restoreInputRef.current?.click()}
                className="flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-lg bg-[var(--panel)] border border-[var(--pline)] hover:border-[#00B050] disabled:opacity-60 text-[11px] font-bold transition-colors cursor-pointer"
              >
                <FileUp className="w-3.5 h-3.5 text-[#00B050]" />
                <span>استعادة الكل</span>
              </button>
            </div>

            {backupNotice && (
              <div className="px-2.5 py-1.5 rounded-lg bg-[#00B050]/12 border border-[#00B050]/35 text-[11px] text-[#00B050] dark:text-[#6ee7b7]">
                {backupNotice}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
