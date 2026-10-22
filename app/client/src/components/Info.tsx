// The app's one way to explain a number: a small ⓘ that shows a short, impersonal definition (and a formula, when
// there is one) on hover. Longer method notes live on the Methods & assumptions page.
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@databricks/appkit-ui/react";
import { Info as InfoIcon } from "lucide-react";

export function Info({ children, formula, source }: { children: ReactNode; formula?: string; source?: { label: string; href: string } }) {
  return (
    <Tooltip delayDuration={100}>
      <TooltipTrigger asChild>
        <button type="button" className="inline-flex align-middle text-muted-foreground hover:text-foreground" aria-label="definition">
          <InfoIcon className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm text-left text-xs leading-relaxed" side="top">
        <div>{children}</div>
        {formula && <div className="mt-1.5 rounded bg-black/20 px-2 py-1 font-mono text-[11px]">{formula}</div>}
        {source && <a href={source.href} target="_blank" rel="noreferrer" className="mt-1.5 block underline">{source.label}</a>}
      </TooltipContent>
    </Tooltip>
  );
}

/** Section title with an optional ⓘ. */
export function Title({ children, info, formula, source }: { children: ReactNode; info?: ReactNode; formula?: string; source?: { label: string; href: string } }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {children}
      {info && <Info formula={formula} source={source}>{info}</Info>}
    </span>
  );
}

export const CNAIM = { label: "Ofgem DNO Common Network Asset Indices Methodology v2.1", href: "https://www.ofgem.gov.uk/sites/default/files/docs/2021/04/dno_common_network_asset_indices_methodology_v2.1_final_01-04-2021.pdf" };
export const IEEE1366 = { label: "IEEE 1366, Guide for Electric Power Distribution Reliability Indices", href: "https://standards.ieee.org/ieee/1366/7243/" };
