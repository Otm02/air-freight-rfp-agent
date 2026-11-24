"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
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
import {
  INPUT,
  PANEL,
  PANEL_HEADER,
  StatusDot,
  StatusMark,
  TH,
  buttonClass,
} from "./ui";
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

  const tabClass = (active: boolean) =>
    `inline-flex h-7 items-center gap-1.5 rounded-xs px-2.5 text-xs font-medium transition-colors ${
      active
        ? "bg-zinc-100 text-zinc-900"
        : "text-zinc-500 hover:text-zinc-900"
    }`;

  const fieldLabel = "eyebrow mb-1.5 block";
  const laneInput = `${INPUT} h-8`;

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

      <main className="mx-auto max-w-[1120px] space-y-10 px-6 py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
              RFP Inbox
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-zinc-500">
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
            className={buttonClass("secondary")}
          >
            Refresh
          </button>
        </div>

        <section className={`${PANEL} overflow-hidden`}>
          <div className={PANEL_HEADER}>
            <h2 className="text-sm font-medium text-zinc-900">
              RFPs
              <span className="ml-1.5 font-normal text-zinc-500 tabular-nums">
                ({rfps.length})
              </span>
            </h2>
            <span className="text-xs text-zinc-500">
              Select a tender to inspect lanes, resolve checkpoints, or view the activity log
            </span>
          </div>

          <div className="scroll-thin overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50/60">
                  <th className={`${TH} py-2 pr-2 pl-4`}>RFP &amp; Shipper</th>
                  <th className={`${TH} px-2 py-2`}>Stage</th>
                  <th className={`${TH} px-2 py-2 text-right`}>Scope</th>
                  <th className={`${TH} px-2 py-2 text-right`}>Tasks</th>
                  <th className={`${TH} px-2 py-2 text-right`}>Value</th>
                  <th className={`${TH} px-2 py-2`}>Updated</th>
                  <th className={`${TH} py-2 pr-4 pl-2 text-right`}>Open</th>
                </tr>
              </thead>
              <tbody>
                {rfps.map((item) => {
                  const statusMeta = getRfpStatusBadge(item.status);
                  return (
                    <tr
                      key={item.id}
                      data-testid={`inbox-rfp-row-${item.id}`}
                      className="border-b border-zinc-100 transition-colors last:border-b-0 hover:bg-zinc-50/70"
                    >
                      <td className="py-2.5 pr-2 pl-4">
                        <Link
                          href={`/rfps/${item.id}`}
                          className="text-sm font-medium text-zinc-900 hover:underline"
                        >
                          {item.title}
                        </Link>
                        <div className="mt-0.5 text-xs text-zinc-500">
                          {item.customerName} ·{" "}
                          <span className="font-mono">{item.customerEmail}</span>
                        </div>
                      </td>

                      <td className="px-2 py-2.5">
                        <StatusMark
                          tone={statusMeta.tone}
                          label={statusMeta.label}
                        />
                      </td>

                      <td className="px-2 py-2.5 text-right tabular-nums">
                        <div className="text-zinc-900">
                          {item.laneCount} lanes
                        </div>
                        <div className="text-xs text-zinc-500">
                          {item.totalTons.toLocaleString("en-US")}t
                        </div>
                      </td>

                      <td className="px-2 py-2.5 text-right tabular-nums">
                        {item.openTasksCount > 0 ? (
                          <span className="inline-flex items-center gap-1.5 font-medium text-zinc-900">
                            <StatusDot tone="warn" />
                            {item.openTasksCount}
                          </span>
                        ) : (
                          <span className="text-zinc-300">0</span>
                        )}
                      </td>

                      <td className="px-2 py-2.5 text-right font-medium text-zinc-900 tabular-nums">
                        {item.estimatedRevenueUsd > 0 ? (
                          formatUsd(item.estimatedRevenueUsd, 2)
                        ) : (
                          <span className="font-normal text-zinc-300">-</span>
                        )}
                      </td>

                      <td className="px-2 py-2.5 text-xs whitespace-nowrap text-zinc-500">
                        {formatDateTimeShort(item.updatedAt)}
                      </td>

                      <td className="py-2.5 pr-4 pl-2 text-right">
                        <Link
                          href={`/rfps/${item.id}`}
                          data-testid={`open-rfp-${item.id}`}
                          className={buttonClass("secondary")}
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

        <section className={PANEL}>
          <div className={PANEL_HEADER}>
            <h2 className="text-sm font-medium text-zinc-900">New Shipper RFP</h2>

            <div className="inline-flex rounded-sm border border-zinc-200 p-0.5">
              <button
                type="button"
                onClick={() => setCreateTab("custom")}
                data-testid="ingest-tab-custom"
                className={tabClass(createTab === "custom")}
              >
                <MailPlus className="h-3.5 w-3.5" />
                Email + Table
              </button>
              <button
                type="button"
                onClick={() => setCreateTab("xlsx")}
                data-testid="ingest-tab-xlsx"
                className={tabClass(createTab === "xlsx")}
              >
                <Upload className="h-3.5 w-3.5" />
                Upload .xlsx
              </button>
              <button
                type="button"
                onClick={() => setCreateTab("preset")}
                data-testid="ingest-tab-preset"
                className={tabClass(createTab === "preset")}
              >
                <Database className="h-3.5 w-3.5" />
                Presets
              </button>
            </div>
          </div>

          <div className="p-5">
            {errorMsg && (
              <div
                role="alert"
                className="mb-4 rounded-sm border border-zinc-200 border-l-2 border-l-red-600 bg-white px-3 py-2 text-xs text-red-700"
              >
                {errorMsg}
              </div>
            )}

            {createTab === "custom" && (
              <form onSubmit={handleCreateCustom} className="space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="max-w-2xl text-xs text-zinc-500">
                    Enter shipper metadata and lane text. Unrecognized terms (such as dry ice or -20 C) pause intake for manual confirmation.
                  </p>
                  <button
                    type="button"
                    onClick={loadAmbiguousSample}
                    className={buttonClass("secondary")}
                  >
                    Load Ambiguous Sample
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div>
                    <label className={fieldLabel}>RFP Title</label>
                    <input
                      type="text"
                      required
                      value={customTitle}
                      onChange={(e) => setCustomTitle(e.target.value)}
                      data-testid="custom-rfp-title"
                      className={`${INPUT} h-8`}
                    />
                  </div>
                  <div>
                    <label className={fieldLabel}>Customer Name</label>
                    <input
                      type="text"
                      required
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      data-testid="custom-customer-name"
                      className={`${INPUT} h-8`}
                    />
                  </div>
                  <div>
                    <label className={fieldLabel}>Customer Email</label>
                    <input
                      type="email"
                      required
                      value={customerEmail}
                      onChange={(e) => setCustomerEmail(e.target.value)}
                      data-testid="custom-customer-email"
                      className={`${INPUT} h-8`}
                    />
                  </div>
                </div>

                <div className="divide-y divide-zinc-100 border-y border-zinc-200">
                  {customLanes.map((row, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-1 gap-3 py-3 sm:grid-cols-[72px_72px_80px_88px_minmax(0,1fr)_28px]"
                    >
                      <div>
                        <label className={fieldLabel}>Origin</label>
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
                          className={`${laneInput} font-mono uppercase`}
                        />
                      </div>
                      <div>
                        <label className={fieldLabel}>Dest</label>
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
                          className={`${laneInput} font-mono uppercase`}
                        />
                      </div>
                      <div>
                        <label className={fieldLabel}>Tons</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0.1"
                          required
                          value={row.tons}
                          onChange={(e) =>
                            updateLaneRow(idx, { tons: e.target.value })
                          }
                          className={`${laneInput} text-right tabular-nums`}
                        />
                      </div>
                      <div>
                        <label className={fieldLabel}>Max Days</label>
                        <input
                          type="number"
                          min="1"
                          required
                          value={row.maxTransitDays}
                          onChange={(e) =>
                            updateLaneRow(idx, { maxTransitDays: e.target.value })
                          }
                          className={`${laneInput} text-right tabular-nums`}
                        />
                      </div>
                      <div>
                        <label className={fieldLabel}>Shipper Email Text</label>
                        <input
                          type="text"
                          required
                          value={row.rawEmail}
                          onChange={(e) =>
                            updateLaneRow(idx, { rawEmail: e.target.value })
                          }
                          data-testid={`custom-lane-email-${idx}`}
                          className={laneInput}
                        />
                      </div>
                      <div className="flex items-end">
                        {customLanes.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeLaneRow(idx)}
                            className="flex h-8 w-7 items-center justify-center rounded-sm text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-red-700"
                            aria-label="Remove lane row"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
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
                    className={buttonClass("secondary", "md")}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Lane
                  </button>

                  <button
                    type="submit"
                    disabled={busy}
                    data-testid="submit-custom-rfp"
                    className={buttonClass("primary", "md")}
                  >
                    {busy ? "Running Intake & Routing..." : "Run Intake & Routing"}
                  </button>
                </div>
              </form>
            )}

            {createTab === "xlsx" && (
              <form onSubmit={handleUploadXlsx} className="space-y-5">
                <p className="max-w-2xl text-xs text-zinc-500">
                  Upload a workbook with a <code className="font-mono text-zinc-700">Shipper RFP</code> sheet (and optional <code className="font-mono text-zinc-700">Transit Table</code>). If omitted, the built-in 20-airport network applies.
                </p>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <input
                    type="text"
                    placeholder="Optional RFP Title override"
                    value={xlsxTitle}
                    onChange={(e) => setXlsxTitle(e.target.value)}
                    className={`${INPUT} h-8`}
                  />
                  <input
                    type="text"
                    placeholder="Optional Customer Contact"
                    value={xlsxCustomerName}
                    onChange={(e) => setXlsxCustomerName(e.target.value)}
                    className={`${INPUT} h-8`}
                  />
                  <input
                    type="email"
                    placeholder="Optional Customer Email"
                    value={xlsxCustomerEmail}
                    onChange={(e) => setXlsxCustomerEmail(e.target.value)}
                    className={`${INPUT} h-8`}
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-4 rounded-sm border border-dashed border-zinc-300 px-4 py-4">
                  <input
                    type="file"
                    accept=".xlsx"
                    onChange={(e) => setXlsxFile(e.target.files?.[0] ?? null)}
                    data-testid="xlsx-file-input"
                    className="text-xs text-zinc-600 file:mr-3 file:h-7 file:cursor-pointer file:rounded-sm file:border file:border-zinc-200 file:bg-white file:px-2.5 file:text-xs file:font-medium file:text-zinc-800 hover:file:bg-zinc-50"
                  />
                  <button
                    type="submit"
                    disabled={busy || !xlsxFile}
                    className={buttonClass("primary", "md")}
                  >
                    {busy ? "Importing..." : "Upload & Assess"}
                  </button>
                </div>
              </form>
            )}

            {createTab === "preset" && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col rounded-sm border border-zinc-200 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                    <FileSpreadsheet className="h-4 w-4 text-zinc-400" />
                    <span>Showcase Subset (10 Lanes)</span>
                  </div>
                  <p className="mt-1.5 flex-1 text-xs text-zinc-500">
                    Loads 10 lanes from <code className="font-mono text-zinc-700">Air_Freight_RFP_Mock_Data.xlsx</code> covering all 5 status buckets.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleCreatePreset("showcase")}
                    className={buttonClass("primary", "md", "mt-4 self-start")}
                  >
                    Create 10-Lane Showcase RFP
                  </button>
                </div>

                <div className="flex flex-col rounded-sm border border-zinc-200 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                    <FileSpreadsheet className="h-4 w-4 text-zinc-400" />
                    <span>Full Workbook (100 Lanes)</span>
                  </div>
                  <p className="mt-1.5 flex-1 text-xs text-zinc-500">
                    Runs intake and constrained routing across all 100 lanes (4,008.4 tons) in the reference workbook.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleCreatePreset("full100")}
                    data-testid="create-full100-preset"
                    className={buttonClass("secondary", "md", "mt-4 self-start")}
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
