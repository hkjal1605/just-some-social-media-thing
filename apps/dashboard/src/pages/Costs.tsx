// Costs (doc 10 §3.8): MTD spend by service, per-agent table, revenue, P&L line.
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { fmtUsd } from "../lib/format";
import { Card, EmptyState, PageHeader, SectionTitle, Spinner, Table, Td, Th } from "../lib/ui";

interface CostsResp {
  month: string;
  services: { service: string; kind: string; units: number | null; costUsd: number }[];
  agents: {
    agent: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    p95DurationMs: number | null;
  }[];
  spend: number;
  revenue: { campaigns: number; platform: number; total: number };
  netUsd: number;
}

export function Costs() {
  const q = useQuery({ queryKey: ["costs-page"], queryFn: () => api<CostsResp>("/costs") });
  if (q.isLoading || !q.data) return <Spinner />;
  const d = q.data;

  return (
    <div className="space-y-4">
      <PageHeader title="Costs" right={<span className="text-sm text-zinc-500">{d.month}</span>} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Spend MTD" value={fmtUsd(d.spend)} />
        <Stat label="Revenue" value={fmtUsd(d.revenue.total)} tone="emerald" />
        <Stat label="Campaigns" value={fmtUsd(d.revenue.campaigns)} />
        <Stat label="Net" value={fmtUsd(d.netUsd)} tone={d.netUsd >= 0 ? "emerald" : "red"} />
      </div>

      <Card>
        <SectionTitle>By service</SectionTitle>
        {d.services.length === 0 ? (
          <EmptyState>No spend this month.</EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <Th>Service</Th>
                <Th>Kind</Th>
                <Th right>Units</Th>
                <Th right>Cost</Th>
              </tr>
            }
          >
            {d.services.map((s) => (
              <tr key={`${s.kind}:${s.service}`}>
                <Td>{s.service}</Td>
                <Td>{s.kind}</Td>
                <Td right mono>
                  {s.units ?? "—"}
                </Td>
                <Td right mono>
                  {fmtUsd(s.costUsd, 4)}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card>
        <SectionTitle>By agent</SectionTitle>
        {d.agents.length === 0 ? (
          <EmptyState>No agent runs this month.</EmptyState>
        ) : (
          <Table
            head={
              <tr>
                <Th>Agent</Th>
                <Th right>Calls</Th>
                <Th right>In tok</Th>
                <Th right>Out tok</Th>
                <Th right>Cost</Th>
                <Th right>p95 ms</Th>
              </tr>
            }
          >
            {d.agents.map((a) => (
              <tr key={a.agent}>
                <Td>{a.agent}</Td>
                <Td right mono>
                  {a.calls}
                </Td>
                <Td right mono>
                  {a.inputTokens}
                </Td>
                <Td right mono>
                  {a.outputTokens}
                </Td>
                <Td right mono>
                  {fmtUsd(a.costUsd, 4)}
                </Td>
                <Td right mono>
                  {a.p95DurationMs ?? "—"}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "emerald" | "red" }) {
  const color = tone === "emerald" ? "text-emerald-600" : tone === "red" ? "text-red-600" : "";
  return (
    <Card>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${color}`}>{value}</div>
    </Card>
  );
}
