/**
 * Tetti massimi per le liste restituite dalle API, che oggi non sono paginate lato server:
 * l'app riceve l'elenco intero e lo divide in pagine da sola. Senza tetto, una lista che cresce
 * negli anni (storico di un cliente, accrediti di un bar) diventa una risposta sempre più lenta.
 * Si restituiscono gli elementi più recenti: l'ordinamento di ogni query resta quello di prima.
 */

/** Storico personale del cliente: richieste di punti e riscatti di offerte. */
export const USER_HISTORY_LIMIT = 200;

/** Liste del bar: richieste in attesa e accrediti recenti. */
export const BAR_LIST_LIMIT = 500;

/** Amici di un utente (usati anche per scegliere con chi dividere uno scontrino). */
export const FRIENDS_LIST_LIMIT = 500;
