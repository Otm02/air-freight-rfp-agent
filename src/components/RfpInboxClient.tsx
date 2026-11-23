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

  // Custom form state
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

  // XLSX upload state
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
        rawEmail:
          "DFW to MEX requires high-value security on all flights.",
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

  const updateLaneRow = (
    idx: number,
    patch: Partial<CustomLaneDraft>,
  ) => {
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
      setErrorMsg("Please select a .xlsx workbook first.");
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
    <div className="min-h-screen bg-slate-50">
      <AppHeader
        activeModelLabel={activeModelLabel}
        openTasksCount={totalOpenTasks}
        onHumanTasksClick={() => {
          if (firstRfpWithTasks) {
            router.push(`/rfps/${firstRfpWithTasks.id}`);
          }
        }}
      />

      <main className="mx-auto max-w-[1440px] space-y-6 px-4 py-6 sm:px-6">
        {/* Title & Value Prop Strip */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              RFP Response Inbox
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Deterministic flight-graph routing & SLA verification paired with schema-validated AI text agents and auditable human checkpoints.
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
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Refresh List
          </button>
        </div>

        {/* RFP List Table */}
        <section className="rounded-xl border border-slate-200 bg-white shadow-2xs">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">
              Active & Seeded RFPs ({rfps.length})
            </h2>
            <span className="text-xs text-slate-500">
              Click any RFP to open workspace, human checkpoints & live SSE agent graph
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
                  <th className="px-5 py-2.5">RFP Title & Customer</th>
                  <th className="px-3 py-2.5">Pipeline Status</th>
                  <th className="px-3 py-2.5 text-right">Scope</th>
                  <th className="px-3 py-2.5 text-center">Open Tasks</th>
                  <th className="px-3 py-2.5 text-right">Est. / Booked Value</th>
                  <th className="px-3 py-2.5">Updated</th>
                  <th className="px-5 py-2.5 text-right">Workspace</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rfps.map((item) => {
                  const statusMeta = getRfpStatusBadge(item.status);
                  return (
                    <tr
                      key={item.id}
                      data-testid={`inbox-rfp-row-${item.id}`}
                      className="transition hover:bg-slate-50"
                    >
                      <td className="px-5 py-3.5">
                        <Link
                          href={`/rfps/${item.id}`}
                          className="text-sm font-semibold text-slate-900 hover:text-[#1E3A5F]"
                        >
                          {item.title}
                        </Link>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {item.customerName} ·{" "}
                          <span className="font-mono">{item.customerEmail}</span>
                        </div>
                      </td>

                      <td className="px-3 py-3.5">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${statusMeta.badgeClass}`}
                        >
                          {item.isWaitingForHuman && (
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-600" />
                          )}
                          {statusMeta.label}
                        </span>
                      </td>

                      <td className="px-3 py-3.5 text-right tabular-nums">
                        <div className="font-semibold text-slate-900">
                          {item.laneCount} lanes
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {item.totalTons.toLocaleString("en-US")} t
                        </div>
                      </td>

                      <td className="px-3 py-3.5 text-center">
                        {item.openTasksCount > 0 ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-bold text-amber-900 tabular-nums">
                            <AlertCircle className="h-3.5 w-3.5 text-amber-600" />
                            {item.openTasksCount}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400">0</span>
                        )}
                      </td>

                      <td className="px-3 py-3.5 text-right font-semibold text-slate-900 tabular-nums">
                        {item.estimatedRevenueUsd > 0
                          ? formatUsd(item.estimatedRevenueUsd, 2)
                          : "—"}
                      </td>

                      <td className="px-3 py-3.5 text-xs text-slate-500">
                        {formatDateTimeShort(item.updatedAt)}
                      </td>

                      <td className="px-5 py-3.5 text-right">
                        <Link
                          href={`/rfps/${item.id}`}
                          data-testid={`open-rfp-${item.id}`}
                          className="inline-flex items-center gap-1 rounded-lg bg-[#1E3A5F] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#162C49]"
                        >
                          Open
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* New RFP Ingestion Card */}
        <section className="rounded-xl border border-slate-200 bg-white shadow-2xs">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">
              Ingest New Shipper RFP
            </h2>

            <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setCreateTab("custom")}
                data-testid="ingest-tab-custom"
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 font-medium ${
                  createTab === "custom"
                    ? "bg-white text-slate-900 shadow-2xs"
                    : "text-slate-600"
                }`}
              >
                <MailPlus className="h-3.5 w-3.5" />
                Shipper Email + Table
              </button>
              <button
                type="button"
                onClick={() => setCreateTab("xlsx")}
                data-testid="ingest-tab-xlsx"
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 font-medium ${
                  createTab === "xlsx"
                    ? "bg-white text-slate-900 shadow-2xs"
                    : "text-slate-600"
                }`}
              >
                <Upload className="h-3.5 w-3.5" />
                Upload .xlsx
              </button>
              <button
                type="button"
                onClick={() => setCreateTab("preset")}
                data-testid="ingest-tab-preset"
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 font-medium ${
                  createTab === "preset"
                    ? "bg-white text-slate-900 shadow-2xs"
                    : "text-slate-600"
                }`}
              >
                <Database className="h-3.5 w-3.5" />
                Workbook Presets
              </button>
            </div>
          </div>

          <div className="p-5">
            {errorMsg && (
              <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-900">
                {errorMsg}
              </div>
            )}

            {createTab === "custom" && (
              <form onSubmit={handleCreateCustom} className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-slate-600">
                    Submit shipper contact details + raw lane emails. Out-of-catalog phrases (like dry ice or -20 C) trigger a human requirement confirmation checkpoint.
                  </p>
                  <button
                    type="button"
                    onClick={loadAmbiguousSample}
                    className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                  >
                    Load Ambiguous Sample
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold text-slate-600">
                      RFP Title
                    </label>
                    <input
                      type="text"
                      required
                      value={customTitle}
                      onChange={(e) => setCustomTitle(e.target.value)}
                      data-testid="custom-rfp-title"
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs focus:border-[#1E3A5F] focus:outline-hidden"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold text-slate-600">
                      Customer Name
                    </label>
                    <input
                      type="text"
                      required
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      data-testid="custom-customer-name"
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs focus:border-[#1E3A5F] focus:outline-hidden"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold text-slate-600">
                      Customer Email
                    </label>
                    <input
                      type="email"
                      required
                      value={customerEmail}
                      onChange={(e) => setCustomerEmail(e.target.value)}
                      data-testid="custom-customer-email"
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs focus:border-[#1E3A5F] focus:outline-hidden"
                    />
                  </div>
                </div>

                <div className="space-y-2.5">
                  {customLanes.map((row, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-1 gap-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3 sm:grid-cols-[80px_80px_80px_90px_minmax(0,1fr)_auto]"
                    >
                      <div>
                        <label className="mb-1 block text-[10px] font-semibold text-slate-500 uppercase">
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
                          className="w-full rounded border border-slate-200 bg-white px-2 py-1 font-mono text-xs uppercase"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-semibold text-slate-500 uppercase">
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
                          className="w-full rounded border border-slate-200 bg-white px-2 py-1 font-mono text-xs uppercase"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-semibold text-slate-500 uppercase">
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
                          className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-xs tabular-nums"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-semibold text-slate-500 uppercase">
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
                          className="w-full rounded border border-slate-200 bg-white px-2 py-1 text-xs tabular-nums"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-semibold text-slate-500 uppercase">
                          Shipper Email Request Text
                        </label>
                        <input
                          type="text"
                          required
                          value={row.rawEmail}
                          onChange={(e) =>
                            updateLaneRow(idx, { rawEmail: e.target.value })
                          }
                          data-testid={`custom-lane-email-${idx}`}
                          className="w-full rounded border border-slate-200 bg-white px-2.5 py-1 text-xs"
                        />
                      </div>
                      <div className="flex items-end">
                        {customLanes.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeLaneRow(idx)}
                            className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-700"
                            aria-label="Remove lane row"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={addLaneRow}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Lane Row
                  </button>

                  <button
                    type="submit"
                    disabled={busy}
                    data-testid="submit-custom-rfp"
                    className="rounded-lg bg-[#1E3A5F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#162C49] disabled:opacity-50"
                  >
                    {busy ? "Running Intake & Routing..." : "Run Intake & Routing"}
                  </button>
                </div>
              </form>
            )}

            {createTab === "xlsx" && (
              <form onSubmit={handleUploadXlsx} className="space-y-4">
                <p className="text-xs text-slate-600">
                  Upload an Excel workbook containing a <code className="font-mono">Shipper RFP</code> worksheet (and optional <code className="font-mono">Transit Table</code>). If no Transit Table is present, the active 20-airport flight network is used.
                </p>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <input
                    type="text"
                    placeholder="Optional RFP Title override"
                    value={xlsxTitle}
                    onChange={(e) => setXlsxTitle(e.target.value)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
                  />
                  <input
                    type="text"
                    placeholder="Optional Customer Contact"
                    value={xlsxCustomerName}
                    onChange={(e) => setXlsxCustomerName(e.target.value)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
                  />
                  <input
                    type="email"
                    placeholder="Optional Customer Email"
                    value={xlsxCustomerEmail}
                    onChange={(e) => setXlsxCustomerEmail(e.target.value)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-4">
                  <input
                    type="file"
                    accept=".xlsx"
                    onChange={(e) => setXlsxFile(e.target.files?.[0] ?? null)}
                    data-testid="xlsx-file-input"
                    className="text-xs text-slate-700 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1 file:text-xs file:font-semibold file:text-slate-700"
                  />
                  <button
                    type="submit"
                    disabled={busy || !xlsxFile}
                    className="rounded-lg bg-[#1E3A5F] px-4 py-2 text-xs font-semibold text-white hover:bg-[#162C49] disabled:opacity-45"
                  >
                    {busy ? "Importing Workbook..." : "Upload & Assess"}
                  </button>
                </div>
              </form>
            )}

            {createTab === "preset" && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <FileSpreadsheet className="h-4 w-4 text-[#1E3A5F]" />
                    <span>Showcase Subset (10 Lanes)</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">
                    Loads 10 real lanes from <code className="font-mono">Air_Freight_RFP_Mock_Data.xlsx</code> covering all 5 status buckets and multi-option trade-offs.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleCreatePreset("showcase")}
                    className="mt-3 rounded-lg bg-[#1E3A5F] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-[#162C49] disabled:opacity-50"
                  >
                    Create 10-Lane Showcase RFP
                  </button>
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <FileSpreadsheet className="h-4 w-4 text-slate-700" />
                    <span>Full Mock Workbook (100 Lanes)</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-600">
                    Runs intake & deterministic Dijkstra routing across all 100 lanes (4,008.4 tons) in the brief&apos;s workbook.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleCreatePreset("full100")}
                    data-testid="create-full100-preset"
                    className="mt-3 rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-900 hover:bg-slate-100 disabled:opacity-50"
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
