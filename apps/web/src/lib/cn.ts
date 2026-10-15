import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, letting later Tailwind utilities win over earlier ones.
 * Every component takes its classes through here so callers can override any
 * built-in style without specificity fights.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
