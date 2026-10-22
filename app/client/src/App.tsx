import { createBrowserRouter, RouterProvider, NavLink, Outlet } from "react-router";
import { ShieldHalf } from "lucide-react";
import { TooltipProvider } from "@databricks/appkit-ui/react";
import { DataProvider, useStore } from "./lib/store";
import MapPage from "./pages/MapPage";
import PortfolioPage from "./pages/PortfolioPage";
import PlanPage from "./pages/PlanPage";
import ComparePage from "./pages/ComparePage";
import CurvesPage from "./pages/CurvesPage";
import DataModelPage from "./pages/DataModelPage";
import DocsPage from "./pages/DocsPage";
import AskPage from "./pages/AskPage";

const NAV = [
  { to: "/", label: "Territory risk", end: true },
  { to: "/map", label: "Risk map" },
  { to: "/plan", label: "Plan" },
  { to: "/compare", label: "Compare strategies" },
  { to: "/curves", label: "Curves" },
  { to: "/ask", label: "Ask Genie" },
  { to: "/data", label: "Data model" },
  { to: "/docs", label: "Methods & assumptions" },
];

function Shell() {
  const { stage, error, inputs } = useStore();
  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-6 border-b px-6">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <ShieldHalf className="h-5 w-5" style={{ color: "var(--armor)" }} />
          <span className="text-lg font-semibold">ARMOR</span>
          <span className="hidden text-sm text-muted-foreground xl:inline">Asset Risk Modeling &amp; Optimized Renewal</span>
        </div>
        <nav className="flex items-center gap-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition-colors ${isActive ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto truncate text-xs text-muted-foreground" id="status" data-ready={inputs ? "1" : "0"}>
          {error ? <span className="text-destructive">{error}</span> : inputs ? "" : `Loading: ${stage}…`}
        </div>
      </header>
      <main className="relative min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <PortfolioPage /> },
      { path: "/map", element: <MapPage /> },
      { path: "/plan", element: <PlanPage /> },
      { path: "/compare", element: <ComparePage /> },
      { path: "/curves", element: <CurvesPage /> },
      { path: "/data", element: <DataModelPage /> },
      { path: "/docs", element: <DocsPage /> },
      { path: "/ask", element: <AskPage /> },
    ],
  },
]);

export default function App() {
  return (
    <DataProvider>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </DataProvider>
  );
}
