export interface BadgeDef {
  emoji: string;
  name: string;
  desc: string;
}

export const BADGES: Record<string, BadgeDef> = {
  first_blood: { emoji: '🩸', name: 'First Blood', desc: 'Win your first hand' },
  ten_wins: { emoji: '🔥', name: 'On Fire', desc: 'Win 10 hands' },
  fifty_wins: { emoji: '⚡', name: 'Lightning', desc: 'Win 50 hands' },
  hundred_wins: { emoji: '👑', name: 'Centurion', desc: 'Win 100 hands' },
  big_pot: { emoji: '💰', name: 'High Roller', desc: 'Win a pot over 500 chips' },
  huge_pot: { emoji: '🏦', name: 'Bank Breaker', desc: 'Win a pot over 2000 chips' },
  all_in_win: { emoji: '🎯', name: 'All or Nothing', desc: 'Win an all-in showdown' },
  comeback: { emoji: '🔄', name: 'Comeback Kid', desc: 'Win after using a rebuy' },
  bluff_master: { emoji: '🎭', name: 'Bluff Master', desc: 'Win 5 hands by making everyone fold' },
  trash_talker: { emoji: '🗣️', name: 'Trash Talker', desc: 'Send 50 chat messages' },
  diamond_elo: { emoji: '💎', name: 'Diamond Mind', desc: 'Reach Diamond ELO (1400+)' },
  shark: { emoji: '🦈', name: 'Shark', desc: 'Win 10 hands in a row' },
};

export type BadgeId = keyof typeof BADGES;

export interface EarnedBadge {
  badgeId: string;
  emoji: string;
  name: string;
  desc: string;
  earnedAt: number;
}

/**
 * Check which badges a winner should earn after a hand ends.
 * Returns array of badge_ids to award.
 */
export function checkBadges(opts: {
  handsWon: number;
  elo: number;
  rebuys: number;
  pot: number;
  isFoldWin: boolean;
  hadAllIn: boolean;
  foldWins: number;
  winStreak: number;
  totalChats: number;
  existingBadges: Set<string>;
}): string[] {
  const earned: string[] = [];

  function maybe(id: string) {
    if (!opts.existingBadges.has(id)) earned.push(id);
  }

  // Win count badges
  if (opts.handsWon >= 1) maybe('first_blood');
  if (opts.handsWon >= 10) maybe('ten_wins');
  if (opts.handsWon >= 50) maybe('fifty_wins');
  if (opts.handsWon >= 100) maybe('hundred_wins');

  // Pot size badges
  if (opts.pot > 500) maybe('big_pot');
  if (opts.pot > 2000) maybe('huge_pot');

  // All-in win
  if (opts.hadAllIn && !opts.isFoldWin) maybe('all_in_win');

  // Comeback (has used rebuy and still winning)
  if (opts.rebuys > 0) maybe('comeback');

  // Bluff master (5+ fold wins)
  if (opts.foldWins >= 5) maybe('bluff_master');

  // Trash talker
  if (opts.totalChats >= 50) maybe('trash_talker');

  // Diamond ELO
  if (opts.elo >= 1400) maybe('diamond_elo');

  // Shark (10 win streak)
  if (opts.winStreak >= 10) maybe('shark');

  return earned;
}
