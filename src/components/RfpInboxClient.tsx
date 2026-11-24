"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowRight,
  Database,
  FileSpreadsheet,
  MailPlus,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import type { RfpListItem } from "../orchestrator/types";
import { AppHeader } from "./AppHeader";
import { formatDateTimeShort, formatUsd, getRfpStatusBadge } from "./ui-helpers";

interface CustomLaneDraft {
  origin: string;
  destination: string;
  tons: string;
  maxTransitDays: string;
  rawEmail: string;
}

interface RfpInboxClientProps {
  initialRfps: RfpListItem[];
  activeModelLabel: string;
}

export function RfpInboxClient({
  initialRfps,
  activeModelLabel,
}: RfpInboxClientProps) {
  const router = useRouter();
  const [rfps, setRfps] = useState<RfpListItem[]>(initialRfps);
  const [createTab, setCreateTab] = useState<"custom" | "xlsx" | "preset">(
    "custom",
  );
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [customTitle, setCustomTitle] = useState("Q1 Nordics Pharma Trial RFP");
  const [customerName, setCustomerName] = useState("Dr. Jonas Lind");
  const [customerEmail, setCustomerEmail] = useState(
    "jonas.lind@nordicpharma.example",
  );
  const [customLanes, setCustomLanes] = useState<CustomLaneDraft[]>([
    {
      origin: "MEX",
      destination: "CDG",
      tons: "14.5",
      maxTransitDays: "11",
      rawEmail:
        "Please quote MEX to CDG requiring dangerous goods handling and dry ice cooling at -20 C throughout.",
    },
  ]);

  const [xlsxFile, setXlsxFile] = useState<File | null>(null);
  const [xlsxTitle, setXlsxTitle] = useState("");
  const [xlsxCustomerName, setXlsxCustomerName] = useState("");
  const [xlsxCustomerEmail, setXlsxCustomerEmail] = useState("");

  const totalOpenTasks = rfps.reduce((sum, r) => sum + r.openTasksCount, 0);

  const loadAmbiguousSample = () => {
    setCustomTitle("Biologics Dry-Ice + Cold-Chain Sample");
    setCustomerName("Dr. Samira Khan");
    setCustomerEmail("samira.khan@biologics.example");
    setCustomLanes([
      {
        origin: "MEX",
        destination: "CDG",
        tons: "12.0",
        maxTransitDays: "11",
        rawEmail:
          "Urgent biologics lane MEX-CDG: dangerous goods on every leg, plus dry ice (-20 C) thermal packaging.",
      },
      {
        origin: "DFW",
        destination: "MEX",
        tons: "18.0",
        maxTransitDays: "17",
        rawEmail: "DFW to MEX requires high-value security on all flights.",
      },
    ]);
  };

  const addLaneRow = () => {
    setCustomLanes((prev) => [
      ...prev,
      {
        origin: "GRU",
        destination: "BOG",
        tons: "15.0",
        maxTransitDays: "12",
        rawEmail:
          "Temperature controlled (2-8 C) and fragile handling required throughout.",
      },
    ]);
  };

  const updateLaneRow = (idx: number, patch: Partial<CustomLaneDraft>) => {
    setCustomLanes((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)),
    );
  };

  const removeLaneRow = (idx: number) => {
    setCustomLanes((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleCreateCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/rfps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "custom",
          title: customTitle,
          customerName,
          customerEmail,
          lanes: customLanes.map((l) => ({
            origin: l.origin.trim().toUpperCase(),
            destination: l.destination.trim().toUpperCase(),
            tons: Number(l.tons),
            maxTransitDays: Number(l.maxTransitDays),
            rawEmail: l.rawEmail,
          })),
        }),
      });
      const json: unknown = await res.json();
      if (!res.ok) {
        const msg =
          json && typeof json === "object" && "error" in json
            ? String((json as { error: unknown }).error)
            : "Failed to create RFP.";
        setErrorMsg(msg);
        return;
      }
      const { rfpId } = json as { rfpId: number };
      router.push(`/rfps/${rfpId}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleUploadXlsx = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!xlsxFile) {
      setErrorMsg("Select a .xlsx workbook first.");
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", xlsxFile);
      if (xlsxTitle.trim()) fd.append("title", xlsxTitle.trim());
      if (xlsxCustomerName.trim())
        fd.append("customerName", xlsxCustomerName.trim());
      if (xlsxCustomerEmail.trim())
        fd.append("customerEmail", xlsxCustomerEmail.trim());

      const res = await fetch("/api/rfps", { method: "POST", body: fd });
      const json: unknown = await res.json();
      if (!res.ok) {
        const msg =
          json && typeof json === "object" && "error" in json
            ? String((json as { error: unknown }).error)
            : "Failed to import workbook.";
        setErrorMsg(msg);
        return;
      }
      const { rfpId } = json as { rfpId: number };
      router.push(`/rfps/${rfpId}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreatePreset = async (preset: "showcase" | "full100") => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/rfps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "preset", preset }),
      });
      const json: unknown = await res.json();
      if (!res.ok) {
        const msg =
          json && typeof json === "object" && "error" in json
            ? String((json as { error: unknown }).error)
            : "Failed to load preset.";
        setErrorMsg(msg);
        return;
      }
      const { rfpId } = json as { rfpId: number };
      router.push(`/rfps/${rfpId}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const firstRfpWithTasks = rfps.find((r) => r.openTasksCount > 0) ?? rfps[0];

  return (
    <div className="min-h-screen bg-canvas">
      <AppHeader
        activeModelLabel={activeModelLabel}
        openTasksCount={totalOpenTasks}
        onHumanTasksClick={() => {
          if (firstRfpWithTasks) {
            router.push(`/rfps/${firstRfpWithTasks.id}`);
          }
        }}
      />

      <main className="mx-auto max-w-[1440px] space-y-5 px-4 py-5 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-lg font-medium tracking-tight text-zinc-900">
              RFP Inbox
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500">
              Ingest shipper workbooks or lane requests. Routing runs deterministically; ambiguous requirements, pricing gaps, and final quotes pause for sign-off.
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              const res = await fetch("/api/rfps");
              if (res.ok) {
                const json = (await res.json()) as { rfps: RfpListItem[] };
                setRfps(json.rfps);
              }
            }}
            className="h-7 rounded-sm border border-border/70 bg-white px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Refresh
          </button>
        </div>

        <section className="rounded-md border border-border/70 bg-white shadow-xs">
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
            <h2 className="text-[13px] font-medium text-zinc-900">
              RFPs ({rfps.length})
            </h2>
            <span className="text-[11px] text-zinc-500">
              Select a tender to inspect lanes, resolve checkpoints, or view the activity log
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-border/60 bg-zinc-50/60 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
                  <th className="px-4 py-2 font-medium">RFP & Shipper</th>
                  <th className="px-3 py-2 font-medium">Stage</th>
                  <th className="px-3 py-2 text-right font-medium">Scope</th>
                  <th className="px-3 py-2 text-center font-medium">Tasks</th>
                  <th className="px-3 py-2 text-right font-medium">Value</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                  <th className="px-4 py-2 text-right font-medium">Open</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {rfps.map((item) => {
                  const statusMeta = getRfpStatusBadge(item.status);
                  return (
                    <tr
                      key={item.id}
                      data-testid={`inbox-rfp-row-${item.id}`}
                      className="transition-colors hover:bg-zinc-50/80"
                    >
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/rfps/${item.id}`}
                          className="text-[13px] font-medium text-zinc-900 hover:underline"
                        >
                          {item.title}
                        </Link>
                        <div className="mt-0.5 text-[11px] text-zinc-500">
                          {item.customerName} ·{" "}
                          <span className="font-mono">{item.customerEmail}</span>
                        </div>
                      </td>

                      <td className="px-3 py-2.5">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-px text-[11px] font-medium ${statusMeta.badgeClass}`}
                        >
                          {item.isWaitingForHuman && (
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                          )}
                          {statusMeta.label}
                        </span>
                      </td>

                      <td className="px-3 py-2.5 text-right tabular-nums">
                        <div className="font-medium text-zinc-900">
                          {item.laneCount} lanes
                        </div>
                        <div className="text-[11px] text-zinc-500">
                          {item.totalTons.toLocaleString("en-US")}t
                        </div>
                      </td>

                      <td className="px-3 py-2.5 text-center">
                        {item.openTasksCount > 0 ? (
                          <span className="inline-flex items-center gap-1 rounded-sm border border-amber-300/80 bg-amber-50 px-1.5 py-px text-[11px] font-medium text-amber-900 tabular-nums">
                            <AlertCircle className="h-3 w-3 text-amber-600" />
                            {item.openTasksCount}
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-400">0</span>
                        )}
                      </td>

                      <td className="px-3 py-2.5 text-right font-medium text-zinc-900 tabular-nums">
                        {item.estimatedRevenueUsd > 0
                          ? formatUsd(item.estimatedRevenueUsd, 2)
                          : "-"}
                      </td>

                      <td className="px-3 py-2.5 text-[11px] text-zinc-500">
                        {formatDateTimeShort(item.updatedAt)}
                      </td>

                      <td className="px-4 py-2.5 text-right">
                        <Link
                          href={`/rfps/${item.id}`}
                          data-testid={`open-rfp-${item.id}`}
                          className="inline-flex h-7 items-center gap-1 rounded-sm bg-zinc-900 px-2.5 text-xs font-medium text-white hover:bg-zinc-800"
                        >
                          Open
                          <ArrowRight className="h-3 w-3" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-md border border-border/70 bg-white shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
            <h2 className="text-[13px] font-medium text-zinc-900">
              New Shipper RFP
            </h2>

            <div className="inline-flex rounded-sm border border-border/70 bg-zinc-50 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setCreateTab("custom")}
                data-testid="ingest-tab-custom"
                className={`inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 font-medium ${
                  createTab === "custom"
                    ? "bg-white text-zinc-900 shadow-xs"
                    : "text-zinc-600"
                }`}
              >
                <MailPlus className="h-3.5 w-3.5" />
                Email + Table
              </button>
              <button
                type="button"
                onClick={() => setCreateTab("xlsx")}
                data-testid="ingest-tab-xlsx"
                className={`inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 font-medium ${
                  createTab === "xlsx"
                    ? "bg-white text-zinc-900 shadow-xs"
                    : "text-zinc-600"
                }`}
              >
                <Upload className="h-3.5 w-3.5" />
                Upload .xlsx
              </button>
              <button
                type="button"
                onClick={() => setCreateTab("preset")}
                data-testid="ingest-tab-preset"
                className={`inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 font-medium ${
                  createTab === "preset"
                    ? "bg-white text-zinc-900 shadow-xs"
                    : "text-zinc-600"
                }`}
              >
                <Database className="h-3.5 w-3.5" />
                Presets
              </button>
            </div>
          </div>

          <div className="p-4">
            {errorMsg && (
              <div className="mb-3 rounded-sm border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                {errorMsg}
              </div>
            )}

            {createTab === "custom" && (
              <form onSubmit={handleCreateCustom} className="space-y-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-zinc-500">
                    Enter shipper metadata and lane text. Unrecognized terms (such as dry ice or -20 C) pause intake for manual confirmation.
                  </p>
                  <button
                    type="button"
                    onClick={loadAmbiguousSample}
                    className="rounded-sm border border-border/70 bg-zinc-50 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100"
                  >
                    Load Ambiguous Sample
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-zinc-600">
                      RFP Title
                    </label>
                    <input
                      type="text"
                      required
                      value={customTitle}
                      onChange={(e) => setCustomTitle(e.target.value)}
                      data-testid="custom-rfp-title"
                      className="h-8 w-full rounded-sm border border-border/70 px-2.5 text-xs focus:border-zinc-400 focus:outline-hidden"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-zinc-600">
                      Customer Name
                    </label>
                    <input
                      type="text"
                      required
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      data-testid="custom-customer-name"
                      className="h-8 w-full rounded-sm border border-border/70 px-2.5 text-xs focus:border-zinc-400 focus:outline-hidden"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-zinc-600">
                      Customer Email
                    </label>
                    <input
                      type="email"
                      required
                      value={customerEmail}
                      onChange={(e) => setCustomerEmail(e.target.value)}
                      data-testid="custom-customer-email"
                      className="h-8 w-full rounded-sm border border-border/70 px-2.5 text-xs focus:border-zinc-400 focus:outline-hidden"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  {customLanes.map((row, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-1 gap-2 rounded-sm border border-border/70 bg-zinc-50/60 p-2.5 sm:grid-cols-[72px_72px_76px_84px_minmax(0,1fr)_auto]"
                    >
                      <div>
                        <label className="mb-1 block text-[10px] font-medium text-zinc-500 uppercase">
                          Origin
                        </label>
                        <input
                          type="text"
                          maxLength={3}
                          required
                          value={row.origin}
                          onChange={(e) =>
                            updateLaneRow(idx, {
                              origin: e.target.value.toUpperCase(),
                            })
                          }
                          className="h-7 w-full rounded-sm border border-border/70 bg-white px-2 font-mono text-xs uppercase"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-medium text-zinc-500 uppercase">
                          Dest
                        </label>
                        <input
                          type="text"
                          maxLength={3}
                          required
                          value={row.destination}
                          onChange={(e) =>
                            updateLaneRow(idx, {
                              destination: e.target.value.toUpperCase(),
                            })
                          }
                          className="h-7 w-full rounded-sm border border-border/70 bg-white px-2 font-mono text-xs uppercase"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-medium text-zinc-500 uppercase">
                          Tons
                        </label>
                        <input
                          type="number"
                          step="0.1"
                          min="0.1"
                          required
                          value={row.tons}
                          onChange={(e) =>
                            updateLaneRow(idx, { tons: e.target.value })
                          }
                          className="h-7 w-full rounded-sm border border-border/70 bg-white px-2 text-xs tabular-nums"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-medium text-zinc-500 uppercase">
                          Max Days
                        </label>
                        <input
                          type="number"
                          min="1"
                          required
                          value={row.maxTransitDays}
                          onChange={(e) =>
                            updateLaneRow(idx, { maxTransitDays: e.target.value })
                          }
                          className="h-7 w-full rounded-sm border border-border/70 bg-white px-2 text-xs tabular-nums"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-medium text-zinc-500 uppercase">
                          Shipper Email Text
                        </label>
                        <input
                          type="text"
                          required
                          value={row.rawEmail}
                          onChange={(e) =>
                            updateLaneRow(idx, { rawEmail: e.target.value })
                          }
                          data-testid={`custom-lane-email-${idx}`}
                          className="h-7 w-full rounded-sm border border-border/70 bg-white px-2.5 text-xs"
                        />
                      </div>
                      <div className="flex items-end">
                        {customLanes.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeLaneRow(idx)}
                            className="rounded-sm p-1 text-zinc-400 hover:bg-rose-50 hover:text-rose-700"
                            aria-label="Remove lane row"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2.5">
                  <button
                    type="button"
                    onClick={addLaneRow}
                    className="inline-flex h-8 items-center gap-1 rounded-sm border border-border/70 bg-white px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Lane
                  </button>

                  <button
                    type="submit"
                    disabled={busy}
                    data-testid="submit-custom-rfp"
                    className="h-8 rounded-sm bg-zinc-900 px-3.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {busy ? "Running Intake & Routing..." : "Run Intake & Routing"}
                  </button>
                </div>
              </form>
            )}

            {createTab === "xlsx" && (
              <form onSubmit={handleUploadXlsx} className="space-y-3.5">
                <p className="text-xs text-zinc-500">
                  Upload a workbook with a <code className="font-mono">Shipper RFP</code> sheet (and optional <code className="font-mono">Transit Table</code>). If omitted, the built-in 20-airport network applies.
                </p>

                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  <input
                    type="text"
                    placeholder="Optional RFP Title override"
                    value={xlsxTitle}
                    onChange={(e) => setXlsxTitle(e.target.value)}
                    className="h-8 rounded-sm border border-border/70 px-2.5 text-xs"
                  />
                  <input
                    type="text"
                    placeholder="Optional Customer Contact"
                    value={xlsxCustomerName}
                    onChange={(e) => setXlsxCustomerName(e.target.value)}
                    className="h-8 rounded-sm border border-border/70 px-2.5 text-xs"
                  />
                  <input
                    type="email"
                    placeholder="Optional Customer Email"
                    value={xlsxCustomerEmail}
                    onChange={(e) => setXlsxCustomerEmail(e.target.value)}
                    className="h-8 rounded-sm border border-border/70 px-2.5 text-xs"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-dashed border-border bg-zinc-50/70 px-4 py-3.5">
                  <input
                    type="file"
                    accept=".xlsx"
                    onChange={(e) => setXlsxFile(e.target.files?.[0] ?? null)}
                    data-testid="xlsx-file-input"
                    className="text-xs text-zinc-700 file:mr-3 file:rounded-sm file:border file:border-border/70 file:bg-white file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-zinc-700"
                  />
                  <button
                    type="submit"
                    disabled={busy || !xlsxFile}
                    className="h-8 rounded-sm bg-zinc-900 px-3.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-45"
                  >
                    {busy ? "Importing..." : "Upload & Assess"}
                  </button>
                </div>
              </form>
            )}

            {createTab === "preset" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-border/70 bg-zinc-50/60 p-3.5">
                  <div className="flex items-center gap-2 text-[13px] font-medium text-zinc-900">
                    <FileSpreadsheet className="h-4 w-4 text-zinc-700" />
                    <span>Showcase Subset (10 Lanes)</span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    Loads 10 lanes from <code className="font-mono">Air_Freight_RFP_Mock_Data.xlsx</code> covering all 5 status buckets.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleCreatePreset("showcase")}
                    className="mt-3 h-7 rounded-sm bg-zinc-900 px-3 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                  >
                    Create 10-Lane Showcase RFP
                  </button>
                </div>

                <div className="rounded-md border border-border/70 bg-zinc-50/60 p-3.5">
                  <div className="flex items-center gap-2 text-[13px] font-medium text-zinc-900">
                    <FileSpreadsheet className="h-4 w-4 text-zinc-700" />
                    <span>Full Workbook (100 Lanes)</span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    Runs intake and constrained routing across all 100 lanes (4,008.4 tons) in the reference workbook.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleCreatePreset("full100")}
                    data-testid="create-full100-preset"
                    className="mt-3 h-7 rounded-sm border border-border bg-white px-3 text-xs font-medium text-zinc-900 hover:bg-zinc-100 disabled:opacity-50"
                  >
                    Load All 100 Lanes
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
