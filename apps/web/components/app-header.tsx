"use client";

import { Clapperboard, LogOut, Moon, Sun, UserRound } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, type User } from "@/lib/api";
import { cn } from "@/lib/utils";

export function AppHeader({ user, live }: { user: User | null; live?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();

  const nav = [{ href: "/", label: "Library" }, ...(user?.isAdmin ? [{ href: "/admin", label: "Ops" }] : [])];

  async function logout() {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    router.replace("/login");
  }

  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:gap-6 md:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <Clapperboard className="size-5 text-primary" />
          <span className="hidden min-[400px]:inline">StreamForge</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                "rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground",
                (n.href === "/" ? pathname === "/" || pathname.startsWith("/videos") : pathname.startsWith(n.href)) &&
                  "bg-muted text-foreground",
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {live !== undefined && (
            <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex" title="Live updates (SSE)">
              <span className={cn("size-2 rounded-full", live ? "bg-emerald-500" : "bg-muted-foreground/40")} />
              {live ? "Live" : "Offline"}
            </span>
          )}
          <button
            aria-label="Toggle theme"
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            className={buttonVariants({ variant: "ghost", size: "icon" })}
          >
            <Sun className="hidden size-4 dark:block" />
            <Moon className="size-4 dark:hidden" />
          </button>
          {user && (
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="Account" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "max-w-48")}>
                <UserRound className="size-4 sm:hidden" />
                <span className="hidden truncate sm:inline">{user.email}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="max-w-64 truncate">{user.email}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logout}>
                  <LogOut className="size-4" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </header>
  );
}
