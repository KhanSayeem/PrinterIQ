import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** The shadcn class merger, which the 21st.dev components expect at this path. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
