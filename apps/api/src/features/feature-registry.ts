import { FeatureMode, SettingScope } from '@prisma/client';

/**
 * Single catalogue of every feature the Administration Center can control.
 *
 * Rules baked in here (not in the UI):
 *  - `default` preserves what the platform did BEFORE this module existed, so deploying it
 *    changes nothing until an administrator decides otherwise. New capabilities default to OFF.
 *  - `locked` features can never be changed: they are safety rules (human approval, plan
 *    verification) shown to the administrator but not toggleable.
 *  - `modes` lists the only values accepted. A toggle is [OFF, AUTO] (AUTO = "enabled").
 *    AI content features never accept AUTO: AI output is always reviewed by a human.
 *  - `stopByEmergency` features become OFF while the emergency stop is active.
 *  - `stopByPause` features become OFF while publishing is paused (legacy global pause).
 *  - `requires` is a dependency: the feature is capped to OFF unless the dependency is
 *    at least `min`. It prevents unsafe or meaningless combinations.
 */
export type FeatureGroup = 'publishing' | 'comments' | 'ai' | 'planning' | 'media' | 'analytics';
export type FeatureKind = 'toggle' | 'tri' | 'review_toggle' | 'locked';

export interface FeatureDef {
  key: string;
  group: FeatureGroup;
  label: string;
  description: string;
  kind: FeatureKind;
  modes: FeatureMode[];
  default: FeatureMode;
  locked?: FeatureMode;
  scopes: SettingScope[];
  stopByEmergency: boolean;
  stopByPause?: boolean;
  requires?: { feature: string; min: FeatureMode }[];
  /** Name of the legacy environment switch that acts as a hard ceiling (see FeaturePolicyService). */
  envGate?: 'COMMENT_AUTOMATION' | 'BACKGROUND_SYNC';
}

const ALL_SCOPES: SettingScope[] = ['GLOBAL', 'CAMPAIGN', 'PLATFORM', 'ACCOUNT'];
const GLOBAL_CAMPAIGN: SettingScope[] = ['GLOBAL', 'CAMPAIGN'];
const GLOBAL_ONLY: SettingScope[] = ['GLOBAL'];

const TOGGLE: FeatureMode[] = ['OFF', 'AUTO'];
const REVIEW_TOGGLE: FeatureMode[] = ['OFF', 'REVIEW'];
const TRI: FeatureMode[] = ['OFF', 'REVIEW', 'AUTO'];

export const FEATURES: FeatureDef[] = [
  // ------------------------------------------------------------ publishing
  {
    key: 'publishing.human_approval',
    group: 'publishing',
    label: 'Validation humaine obligatoire',
    description: 'Un post doit être approuvé par un humain avant toute publication. Règle de sécurité non modifiable.',
    kind: 'locked',
    modes: ['REVIEW'],
    default: 'REVIEW',
    locked: 'REVIEW',
    scopes: GLOBAL_ONLY,
    stopByEmergency: false,
  },
  {
    key: 'publishing.auto',
    group: 'publishing',
    label: 'Publication automatique',
    description:
      'Autorise l’exécution automatique des posts DÉJÀ approuvés et programmés en mode AUTO. L’IA ne peut jamais approuver son propre contenu.',
    kind: 'toggle',
    modes: TOGGLE,
    default: 'AUTO',
    scopes: ALL_SCOPES,
    stopByEmergency: true,
    stopByPause: true,
  },
  {
    key: 'publishing.scheduled',
    group: 'publishing',
    label: 'Publication programmée',
    description: 'Le planificateur met en file les posts approuvés à l’heure prévue.',
    kind: 'toggle',
    modes: TOGGLE,
    default: 'AUTO',
    scopes: ALL_SCOPES,
    stopByEmergency: true,
    stopByPause: true,
  },
  {
    key: 'publishing.publish_now',
    group: 'publishing',
    label: 'Publier maintenant',
    description: 'Un approbateur peut autoriser une publication immédiate d’un post approuvé.',
    kind: 'toggle',
    modes: TOGGLE,
    default: 'AUTO',
    scopes: ALL_SCOPES,
    stopByEmergency: true,
    stopByPause: true,
  },

  // ------------------------------------------------------------ comments
  {
    key: 'comments.first_comment',
    group: 'comments',
    label: 'Premier commentaire automatique',
    description: 'Publie les hashtags en premier commentaire après la publication d’un post.',
    kind: 'toggle',
    modes: TOGGLE,
    default: 'OFF',
    scopes: ALL_SCOPES,
    stopByEmergency: true,
    stopByPause: true,
    envGate: 'COMMENT_AUTOMATION',
  },
  {
    key: 'comments.reply',
    group: 'comments',
    label: 'Réponses aux commentaires',
    description:
      'OFF : aucune réponse générée. REVIEW : l’IA prépare, un humain approuve. AUTO : les réponses jugées sûres partent seules (plafond horaire).',
    kind: 'tri',
    modes: TRI,
    default: 'OFF',
    scopes: ALL_SCOPES,
    stopByEmergency: true,
    stopByPause: true,
    envGate: 'COMMENT_AUTOMATION',
  },
  {
    key: 'comments.moderation',
    group: 'comments',
    label: 'Modération des commentaires',
    description: 'Masque ou supprime les commentaires contenant un mot interdit ou un lien.',
    kind: 'toggle',
    modes: TOGGLE,
    default: 'OFF',
    scopes: ALL_SCOPES,
    stopByEmergency: true,
    stopByPause: true,
    envGate: 'COMMENT_AUTOMATION',
  },

  // ------------------------------------------------------------ AI content studio
  {
    key: 'ai.captions',
    group: 'ai',
    label: 'Génération de légendes IA',
    description: 'Caption Studio génère des variantes de légendes. Toujours soumises à une validation humaine.',
    kind: 'review_toggle',
    modes: REVIEW_TOGGLE,
    default: 'REVIEW',
    scopes: GLOBAL_CAMPAIGN,
    stopByEmergency: false,
  },
  {
    key: 'ai.hashtags',
    group: 'ai',
    label: 'Génération de hashtags IA',
    description: 'Suggère et classe des hashtags. Les hashtags ajoutés manuellement restent toujours possibles.',
    kind: 'review_toggle',
    modes: REVIEW_TOGGLE,
    default: 'REVIEW',
    scopes: GLOBAL_CAMPAIGN,
    stopByEmergency: false,
  },
  {
    key: 'ai.learning',
    group: 'ai',
    label: 'Apprentissage par feedback',
    description:
      'Les légendes et hashtags APPROUVÉS (et corrigés) par un humain servent d’exemples pour les générations suivantes. Les suggestions rejetées ne sont jamais réutilisées.',
    kind: 'toggle',
    modes: TOGGLE,
    default: 'OFF',
    scopes: GLOBAL_CAMPAIGN,
    stopByEmergency: false,
    requires: [{ feature: 'ai.captions', min: 'REVIEW' }],
  },
  {
    key: 'ai.performance_ranking',
    group: 'ai',
    label: 'Classement par performance',
    description: 'Le score des hashtags tient compte des résultats mesurés (portée, engagement) des posts publiés.',
    kind: 'toggle',
    modes: TOGGLE,
    default: 'OFF',
    scopes: GLOBAL_CAMPAIGN,
    stopByEmergency: false,
    requires: [{ feature: 'ai.hashtags', min: 'REVIEW' }],
  },
  {
    key: 'ai.trends',
    group: 'ai',
    label: 'Intelligence des tendances',
    description:
      'Utilise uniquement des tendances vérifiées, récentes et non expirées (saisies ou importées). Jamais de tendance inventée.',
    kind: 'toggle',
    modes: TOGGLE,
    default: 'OFF',
    scopes: GLOBAL_CAMPAIGN,
    stopByEmergency: false,
    requires: [{ feature: 'ai.hashtags', min: 'REVIEW' }],
  },

  // ------------------------------------------------------------ planning
  {
    key: 'planning.verification',
    group: 'planning',
    label: 'Vérification éditable du planning',
    description: 'Tout planning extrait par IA doit être comparé au document et vérifié ligne par ligne. Non modifiable.',
    kind: 'locked',
    modes: ['REVIEW'],
    default: 'REVIEW',
    locked: 'REVIEW',
    scopes: GLOBAL_ONLY,
    stopByEmergency: false,
  },
  {
    key: 'planning.ai_extraction',
    group: 'planning',
    label: 'Extraction IA des documents',
    description: 'Gemini lit les PDF, PPTX et Word et propose des lignes de planning, toujours vérifiées par un humain.',
    kind: 'review_toggle',
    modes: REVIEW_TOGGLE,
    default: 'REVIEW',
    scopes: GLOBAL_ONLY,
    stopByEmergency: false,
  },
  {
    key: 'planning.calendar_sync',
    group: 'planning',
    label: 'Synchronisation du calendrier',
    description: 'La validation d’un planning crée les entrées du calendrier.',
    kind: 'toggle',
    modes: TOGGLE,
    default: 'AUTO',
    scopes: GLOBAL_CAMPAIGN,
    stopByEmergency: false,
  },
  {
    key: 'planning.auto_drafts',
    group: 'planning',
    label: 'Création automatique des brouillons',
    description: 'Après validation du planning, les actions « POST » deviennent des brouillons (jamais publiés sans approbation).',
    kind: 'toggle',
    modes: TOGGLE,
    default: 'AUTO',
    scopes: GLOBAL_CAMPAIGN,
    stopByEmergency: false,
    requires: [{ feature: 'planning.calendar_sync', min: 'AUTO' }],
  },

  // ------------------------------------------------------------ media
  {
    key: 'media.uploads',
    group: 'media',
    label: 'Téléversement de médias',
    description: 'Autorise l’ajout de nouveaux fichiers à la médiathèque.',
    kind: 'toggle',
    modes: TOGGLE,
    default: 'AUTO',
    scopes: GLOBAL_ONLY,
    stopByEmergency: false,
  },
  {
    key: 'media.processing',
    group: 'media',
    label: 'Traitement automatique des médias',
    description: 'Analyse et compatibilité plateforme (ffprobe) des fichiers téléversés.',
    kind: 'toggle',
    modes: TOGGLE,
    default: 'AUTO',
    scopes: GLOBAL_ONLY,
    stopByEmergency: false,
  },

  // ------------------------------------------------------------ analytics
  {
    key: 'analytics.collection',
    group: 'analytics',
    label: 'Collecte des statistiques',
    description: 'Récupère automatiquement les métriques des posts publiés (appels Meta en lecture).',
    kind: 'toggle',
    modes: TOGGLE,
    default: 'AUTO',
    scopes: ['GLOBAL', 'PLATFORM', 'ACCOUNT'],
    stopByEmergency: true,
    envGate: 'BACKGROUND_SYNC',
  },
];

const BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));

export const getFeature = (key: string): FeatureDef | undefined => BY_KEY.get(key);
export const isFeatureKey = (key: string): boolean => BY_KEY.has(key);

export const MODE_RANK: Record<FeatureMode, number> = { OFF: 0, REVIEW: 1, AUTO: 2 };
export const minMode = (a: FeatureMode, b: FeatureMode): FeatureMode => (MODE_RANK[a] <= MODE_RANK[b] ? a : b);
export const atLeast = (mode: FeatureMode, need: FeatureMode): boolean => MODE_RANK[mode] >= MODE_RANK[need];