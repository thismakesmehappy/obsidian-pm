/**
 * Canonical time-block definitions shared between the weekly view and task form.
 * Any change here automatically applies to both the board rows and the modal dropdown.
 */

export type TimeBlock = 'all-day' | 'morning' | 'afternoon' | 'evening' | 'flexible'

export const TIME_BLOCKS: { id: TimeBlock; label: string; icon: string }[] = [
  { id: 'all-day',   label: 'All Day',   icon: '📅' },
  { id: 'morning',   label: 'Morning',   icon: '🌞' },
  { id: 'afternoon', label: 'Afternoon', icon: '🌻' },
  { id: 'evening',   label: 'Evening',   icon: '🌙' },
  { id: 'flexible',  label: 'Flexible',  icon: '⏱'  }
]

/** The default block assigned to tasks that have no time_block set. */
export const DEFAULT_TIME_BLOCK: TimeBlock = 'flexible'

export function isTimeBlock(value: unknown): value is TimeBlock {
  return TIME_BLOCKS.some((b) => b.id === value)
}
