// Ask: natural-language questions about the grid and the model outputs, answered by the deployment's Genie space.
// The chat (AppKit Genie components) streams from /api/genie/*, which calls Genie as the app's service principal.
import { useEffect, useState } from "react";
import { Button, Card, CardContent, GenieChatInput, GenieChatMessageList, Spinner, useGenieChat } from "@databricks/appkit-ui/react";
import { MessageSquareText } from "lucide-react";
import { getJSON } from "../lib/api";
import { Title } from "../components/Info";

type Space = { enabled: boolean; title?: string | null; description?: string | null; sample_questions?: string[]; error?: string };

function Chat({ space }: { space: Space }) {
  const { messages, status, error, sendMessage, reset, hasPreviousPage, fetchPreviousPage } = useGenieChat({ alias: "armor" });
  const busy = status === "streaming" || status === "loading-history";
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  const followUps = last?.attachments.flatMap((a) => a.suggestedQuestions ?? []) ?? [];
  const chips = messages.length === 0 ? space.sample_questions ?? [] : busy ? [] : followUps;
  return (
    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <CardContent className="flex min-h-0 flex-1 flex-col p-0">
        {messages.length > 0 && (
          <div className="flex justify-end px-4 pt-3">
            <Button variant="ghost" size="sm" onClick={reset} className="text-xs text-muted-foreground">New conversation</Button>
          </div>
        )}
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
            <MessageSquareText className="h-8 w-8" />
            <div>{space.description ?? "Ask a question about the grid and its failure risk."}</div>
          </div>
        ) : (
          <GenieChatMessageList messages={messages} status={status} hasPreviousPage={hasPreviousPage} onFetchPreviousPage={fetchPreviousPage} className="flex-1" />
        )}
        {error && <div className="border-t bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t px-4 py-3" id="ask-suggestions">
            {chips.map((q) => (
              <button key={q} onClick={() => sendMessage(q)} className="rounded-full border px-3 py-1 text-left text-xs text-muted-foreground hover:border-foreground hover:text-foreground">
                {q}
              </button>
            ))}
          </div>
        )}
        <GenieChatInput onSend={sendMessage} disabled={busy} placeholder="Ask about feeders, assets, outages, inspections or failure risk…" />
      </CardContent>
    </Card>
  );
}

export default function AskPage() {
  const [space, setSpace] = useState<Space | null>(null);
  useEffect(() => {
    getJSON<Space>("/api/genie/space").then(setSpace).catch((e) => setSpace({ enabled: false, error: String(e) }));
  }, []);
  if (!space) return <div className="flex h-full items-center justify-center gap-2 text-muted-foreground"><Spinner /> Loading…</div>;
  return (
    <div className="mx-auto flex h-full max-w-[1100px] flex-col gap-4 px-6 py-6" id="ask">
      <div>
        <h1 className="text-2xl font-bold">
          <Title info="Questions in plain language, answered by a Genie space over the asset data model and the model outputs this application reads. Each answer shows the SQL it ran and its result.">
            {space.title ?? "Ask"}
          </Title>
        </h1>
      </div>
      {space.enabled ? <Chat space={space} /> : (
        <Card><CardContent className="py-6 text-muted-foreground">
          No Genie space is configured for this deployment. Set ARMOR_GENIE_SPACE_ID (with a genie_space app resource) in the deployment target.
          {space.error && <div className="mt-2 text-destructive">{space.error}</div>}
        </CardContent></Card>
      )}
    </div>
  );
}
