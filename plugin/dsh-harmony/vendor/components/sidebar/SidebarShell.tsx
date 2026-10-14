import type { ReactNode } from "react";
import styles from "../SessionSidebar.module.css";

export function SidebarShell({ children }: { children: ReactNode }) {
  return <div className={`session-sidebar-content ${styles.shell}`}>{children}</div>;
}
