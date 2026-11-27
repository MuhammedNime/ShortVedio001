import { QuizProject, createUniqueId } from '../types/quiz';
import {
  CustomTemplatePreset,
  getDefaultCustomStyleId,
  loadCustomPresetsAsync,
  mergeCustomPresetsVault,
} from './customPresets';
import {
  hydrateProjectMedia,
  idbGet,
  listProjectsFromStore,
  normalizeLoadedProject,
  saveProjectToStore,
} from './projectStore';

export const FULL_BACKUP_FORMAT = 'quizpro-reels-studio-full-backup-v1';
const LEGACY_BACKUP_FORMAT = 'shorts-quiz-studio-full-backup-v1';

export interface FullStudioBackup {
  format: typeof FULL_BACKUP_FORMAT;
  exportedAt: number;
  activeProjectId: string;
  projects: QuizProject[];
  customPresets: CustomTemplatePreset[];
  defaultStyleId: string | null;
}

export interface RestoreBackupResult {
  restoredProjectsCount: number;
  restoredPresetsCount: number;
  activeProject: QuizProject;
}

export async function buildFullStudioBackup(
  currentProject: QuizProject
): Promise<FullStudioBackup> {
  await saveProjectToStore(currentProject);

  const summaries = await listProjectsFromStore();
  const projectsMap = new Map<string, QuizProject>();
  projectsMap.set(currentProject.id, await hydrateProjectMedia(normalizeLoadedProject(currentProject)));

  for (const s of summaries) {
    if (projectsMap.has(s.id)) continue;
    try {
      const raw = await idbGet<Partial<QuizProject>>(`project_item_${s.id}`);
      if (raw && Array.isArray(raw.slides) && raw.slides.length > 0) {
        projectsMap.set(s.id, await hydrateProjectMedia(normalizeLoadedProject(raw)));
      }
    } catch {
      // skip unreadable entries
    }
  }

  const customPresets = await loadCustomPresetsAsync();
  const defaultStyleId = getDefaultCustomStyleId();

  return {
    format: FULL_BACKUP_FORMAT,
    exportedAt: Date.now(),
    activeProjectId: currentProject.id,
    projects: Array.from(projectsMap.values()),
    customPresets,
    defaultStyleId,
  };
}

export async function restoreFullStudioBackup(
  rawJsonText: string
): Promise<RestoreBackupResult> {
  const parsed = JSON.parse(rawJsonText) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('ملف النسخة الاحتياطية غير صالح.');
  }

  const isSupportedBackupFormat =
    parsed.format === FULL_BACKUP_FORMAT || parsed.format === LEGACY_BACKUP_FORMAT;

  // Support single-project JSON files seamlessly without colliding on legacy default IDs
  if (
    !isSupportedBackupFormat &&
    Array.isArray(parsed.slides) &&
    parsed.template &&
    parsed.timing
  ) {
    const single = normalizeLoadedProject(parsed as Partial<QuizProject>);
    if (!parsed.id || parsed.id === 'default-shorts-project') {
      single.id = createUniqueId('proj');
    } else {
      const existing = await idbGet<Partial<QuizProject>>(`project_item_${single.id}`);
      if (existing) {
        single.id = createUniqueId('proj');
      }
    }
    await saveProjectToStore(single, { setAsActive: true });
    return {
      restoredProjectsCount: 1,
      restoredPresetsCount: 0,
      activeProject: single,
    };
  }

  if (!isSupportedBackupFormat || !Array.isArray(parsed.projects)) {
    throw new Error('صيغة ملف النسخة الاحتياطية غير معروفة.');
  }

  const normalizedProjects: QuizProject[] = [];
  for (const item of parsed.projects) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<QuizProject>;
    if (!Array.isArray(candidate.slides) || candidate.slides.length === 0) continue;
    normalizedProjects.push(normalizeLoadedProject(candidate));
  }

  if (normalizedProjects.length === 0 && !Array.isArray(parsed.customPresets)) {
    throw new Error('الملف لا يحتوي على مشاريع أو ستايلات صالحة للاستعادة.');
  }

  const incomingPresets = Array.isArray(parsed.customPresets) ? parsed.customPresets : [];
  const defaultStyleId =
    typeof parsed.defaultStyleId === 'string' ? parsed.defaultStyleId : undefined;

  const mergedPresets = await mergeCustomPresetsVault(incomingPresets, defaultStyleId);

  const requestedActiveId =
    typeof parsed.activeProjectId === 'string' ? parsed.activeProjectId : '';
  let activeProj = normalizedProjects[0];

  for (const proj of normalizedProjects) {
    if (proj.id === requestedActiveId) {
      activeProj = proj;
      continue;
    }
    await saveProjectToStore(proj, { setAsActive: false });
  }
  if (activeProj) {
    await saveProjectToStore(activeProj, { setAsActive: true });
  }

  return {
    restoredProjectsCount: normalizedProjects.length,
    restoredPresetsCount: mergedPresets.length,
    activeProject: activeProj ?? normalizeLoadedProject(null),
  };
}
