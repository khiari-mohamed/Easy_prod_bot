import { Platform, PostFormat } from '@prisma/client';

export interface SeedDay {
  date: string; // ISO with the Tunis offset (UTC+1, no DST)
  phase: string;
  label: string;
  content: string;
  execution: string;
  objective: string;
  platforms: Platform[];
  format: PostFormat;
}

const IG: Platform = 'INSTAGRAM';
const FB: Platform = 'FACEBOOK';
const TT: Platform = 'TIKTOK';

/** Day-by-day plan transcribed from "Planning de communication & promotion" (3-14 octobre 2026). */
export const CAMPAIGN_DAYS: SeedDay[] = [
  {
    date: '2026-10-03T00:00:00+01:00', phase: 'CURIOSITÉ', label: '3 OCTOBRE — BANDE-ANNONCE OFFICIELLE',
    content: 'Bande-annonce officielle',
    execution: 'Reel Instagram + TikTok. En Stories : repartager la bande-annonce, sondage, premières réactions et reposts des abonnés.',
    objective: 'Lancement officiel de la campagne.', platforms: [IG, TT], format: 'REEL',
  },
  {
    date: '2026-10-04T00:00:00+01:00', phase: 'CURIOSITÉ', label: '4 OCTOBRE — AFFICHE OFFICIELLE',
    content: 'Affiche officielle',
    execution: "Publier l'affiche sur Instagram et Facebook, puis la repartager en Stories. Sur TikTok, utiliser l'affiche dans un Reel court avec une accroche ou un mouvement léger.",
    objective: "Installer l'identité visuelle du film et donner au public un visuel à reconnaître et à partager.",
    platforms: [IG, FB, TT], format: 'IMAGE',
  },
  {
    date: '2026-10-05T00:00:00+01:00', phase: 'CURIOSITÉ', label: '5 OCTOBRE — PRÉSENTATION DES PERSONNAGES / ACTEURS',
    content: 'Présentation des personnages / acteurs',
    execution: 'Reel « Meet the characters » : personnage, acteur et courte phrase qui le caractérise. Identifier les acteurs pour faciliter les reposts.',
    objective: 'Faire connaître les personnages et profiter des communautés des acteurs.', platforms: [IG, TT], format: 'REEL',
  },
  {
    date: '2026-10-06T00:00:00+01:00', phase: 'CURIOSITÉ', label: '6 OCTOBRE — BEHIND THE SCENES',
    content: 'Behind the scenes',
    execution: 'Reel montrant des moments du tournage. Concept possible : « Ce que vous voyez dans le film VS ce qui se passait derrière la caméra ».',
    objective: 'Humaniser le projet et créer du contenu partageable.', platforms: [IG, TT], format: 'REEL',
  },
  {
    date: '2026-10-07T00:00:00+01:00', phase: 'ATTENTE', label: "7 OCTOBRE — J-2 : ANNONCE DE L'AVANT-PREMIÈRE",
    content: "Annonce de l'avant-première",
    execution: 'Reel + Stories « J-2 ». Plans rapides du film, rappel du 9 octobre, countdown et sondages.',
    objective: "Créer l'attente autour de l'événement.", platforms: [IG, TT], format: 'REEL',
  },
  {
    date: '2026-10-08T00:00:00+01:00', phase: 'ATTENTE', label: "8 OCTOBRE — J-1 : RAPPEL AVANT-PREMIÈRE",
    content: 'Rappel avant-première',
    execution: 'Post/Reel très clair : « DEMAIN ». Mentionner date, lieu, heure et informations pratiques. Stories avec countdown.',
    objective: "Maximiser l'attention avant l'événement.", platforms: [IG, FB, TT], format: 'REEL',
  },
  {
    date: '2026-10-09T00:00:00+01:00', phase: 'ÉVÉNEMENT', label: '9 OCTOBRE — AVANT-PREMIÈRE',
    content: "Créer l'événement",
    execution: "Stories toute la journée : préparation, arrivée des acteurs, invités, salle, coulisses et ambiance. Après la projection : recueillir des réactions spontanées en vidéo.",
    objective: "Transformer l'avant-première en source majeure de contenu.", platforms: [IG], format: 'STORY',
  },
  {
    date: '2026-10-10T00:00:00+01:00', phase: 'ENVIE', label: '10 OCTOBRE — RÉACTIONS DU PUBLIC',
    content: 'Réactions du public',
    execution: 'Reel « Ils ont vu le film… voici leurs réactions ». Réactions courtes et authentiques. Fin : « 14 octobre au cinéma ».',
    objective: 'Créer de la preuve sociale et donner envie.', platforms: [IG, TT], format: 'REEL',
  },
  {
    date: '2026-10-11T00:00:00+01:00', phase: 'ENVIE', label: '11 OCTOBRE — LES ACTEURS RECOMMANDENT LE FILM',
    content: 'Les acteurs recommandent le film',
    execution: 'Vidéo courte : « Pourquoi faut-il voir le film ? » Une phrase par acteur. Encourager les reposts.',
    objective: 'Amplifier la portée grâce aux communautés des acteurs.', platforms: [IG, TT], format: 'REEL',
  },
  {
    date: '2026-10-12T00:00:00+01:00', phase: 'ENVIE', label: '12 OCTOBRE — EXTRAIT À POTENTIEL VIRAL',
    content: 'Extrait à potentiel viral',
    execution: 'Publier une scène courte et drôle, sans spoiler. Angle possible : « On vous laisse juger ».',
    objective: 'Favoriser partages, tags et découverte.', platforms: [IG, TT], format: 'REEL',
  },
  {
    date: '2026-10-13T00:00:00+01:00', phase: 'URGENCE', label: '13 OCTOBRE — J-1 : GROS COMPTE À REBOURS',
    content: 'Gros compte à rebours',
    execution: 'Reel « DEMAIN » avec acteurs, couple, moments drôles, cinéma et affiche. Stories toute la journée avec countdown.',
    objective: "Créer l'urgence avant la sortie.", platforms: [IG, TT], format: 'REEL',
  },
  {
    date: '2026-10-14T00:00:00+01:00', phase: 'CONVERSION', label: '14 OCTOBRE — SORTIE : LE FILM EST AU CINÉMA',
    content: 'Le film est au cinéma',
    execution: 'Reel de sortie. Stories avec salles et horaires. Reposter les premières stories des spectateurs et publier les premières réactions.',
    objective: "Transformer l'attention en fréquentation des salles.", platforms: [IG, TT], format: 'REEL',
  },
];

export const CAMPAIGN_SEED = {
  slug: 'what-else',
  titleLatin: 'What Else',
  // Read from the film poster and the planning file name: TO BE CONFIRMED with the client.
  titleArabic: 'فانا محط باش تتحط',
  hashtags: ['WhatElse'],
  releaseDate: new Date('2026-10-14T00:00:00+01:00'),
  brief: [
    'Distributor: Easy Distribution (Tunisia). Film in cinemas from 14 October 2026.',
    'Preview (avant-première): 9 October 2026. Venue and time: TO CONFIRM.',
    'Cinemas and showtimes for 14 October: TO CONFIRM.',
    'Official hashtags and actor handles: TO CONFIRM.',
    '(Replace these lines with confirmed facts. The caption writer only uses what is written here.)',
  ].join('\n'),
};
