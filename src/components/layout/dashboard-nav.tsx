import Link from "next/link";
import { Files, LayoutDashboard } from "lucide-react";
import { cn } from "@/lib/utils";

type DashboardNavProps = { active: "dashboard" | "documents" };

export function DashboardNav({ active }: DashboardNavProps) {
  const links = [
    { href: "/dashboard", label: "Dashboard", key: "dashboard", icon: LayoutDashboard },
    { href: "/documents", label: "My Documents", key: "documents", icon: Files },
  ] as const;

  return (
    <nav aria-label="Dashboard navigation" className="mb-10 flex flex-wrap gap-2 border-b border-border pb-4">
      {links.map(({ href, label, key, icon: Icon }) => (
        <Link
          key={key}
          href={href}
          aria-current={active === key ? "page" : undefined}
          className={cn(
            "inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/25",
            active === key ? "bg-primary text-white" : "text-muted hover:bg-[#FFF4E5] hover:text-foreground",
          )}
        >
          <Icon aria-hidden="true" className="size-4" />
          {label}
        </Link>
      ))}
    </nav>
  );
}
