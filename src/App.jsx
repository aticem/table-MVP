import React, { useEffect, useState, useRef } from "react";
import { MapContainer, useMap } from "react-leaflet";
import L from "leaflet";
import * as XLSX from "xlsx";

/* Stil seti */
const STYLE = {
  todo: { color: "#0f172a", weight: 1, fillColor: "#9ca3af", fillOpacity: 0.15 },
  half: { color: "#b45309", weight: 2, fillPattern: "stripe-orange", fillOpacity: 0.6 },
  full: { color: "#047857", weight: 2, fillPattern: "stripe-green", fillOpacity: 0.6 }
};

function bindCenteredLabel(lyr, text, className) {
  const center = lyr.getBounds().getCenter();
  lyr.bindTooltip(text, {
    permanent: true,
    direction: "center",
    offset: [0, 0],
    className,
    sticky: false,
    interactive: false
  });
  const tt = lyr.getTooltip?.();
  if (tt && tt.setLatLng) tt.setLatLng(center);
}

function setLayerStatus(lyr, newStatus) {
  lyr.feature.properties.status = newStatus;
  lyr.setStyle(STYLE[newStatus]);
  lyr.unbindTooltip();
  if (newStatus === "half") bindCenteredLabel(lyr, "50%", "table-label yellow");
  if (newStatus === "full") bindCenteredLabel(lyr, "100%", "table-label green");
}

export default function App() {
  const [data, setData] = useState(null);
  const [stats, setStats] = useState({ total: 0, half: 0, full: 0 });
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [formData, setFormData] = useState({
    contractor: "",
    date: new Date().toISOString().split("T")[0],
    workers: ""
  });
  const [selectedLayers, setSelectedLayers] = useState(new Set());
  const [submissions, setSubmissions] = useState(() => {
    try {
      const raw = localStorage.getItem("submissions");
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  });

  const geoRef = useRef(null);
  const fitDone = useRef(false);

  // Drag durumu
  const modeRef = useRef(null); // null | 'paint' | 'erase'
  const buttonsRef = useRef(0);
  const paintedThisDragRef = useRef(new Set());
  const erasedThisDragRef = useRef(new Set());

  useEffect(() => {
    fetch("/tables.geojson")
      .then(r => r.json())
      .then(fc => {
        fc.features.forEach((f, i) => {
          f.properties.id = f.properties.id || `F${i}`;
          f.properties.status = f.properties.status || "todo";
        });
        setData(fc);
        setStats(s => ({ ...s, total: fc.features.length }));
      })
      .catch(e => console.error("GeoJSON load error:", e));
  }, []);

  const updateStats = () => {
    if (!geoRef.current) return;
    let half = 0, full = 0;
    geoRef.current.eachLayer(l => {
      const st = l.feature.properties.status;
      if (st === "half") half++;
      if (st === "full") full++;
    });
    setStats(p => ({ ...p, half, full }));
  };

  const pct = (n, d) => (d ? Math.round((n * 100) / d) : 0);

  function Layer({ fc }) {
    const map = useMap();

    const advanceOneStep = (lyr, dragged = false) => {
      if (!lyr) return;
      const id = lyr.feature.properties.id;
      if (dragged && paintedThisDragRef.current.has(id)) return;

      const cur = lyr.feature.properties.status || "todo";
      if (cur === "todo") setLayerStatus(lyr, "half");
      else if (cur === "half") setLayerStatus(lyr, "full");
      else return;

      if (dragged) paintedThisDragRef.current.add(id);
      updateStats();
    };

    const eraseOne = (lyr, dragged = false) => {
      if (!lyr) return;
      const id = lyr.feature.properties.id;
      if (dragged && erasedThisDragRef.current.has(id)) return;

      if (lyr.feature.properties.status !== "todo") {
        setLayerStatus(lyr, "todo");
        if (dragged) erasedThisDragRef.current.add(id);
        updateStats();
      }
    };

    useEffect(() => {
      if (!fc) return;

      if (geoRef.current) geoRef.current.removeFrom(map);

      const layer = L.geoJSON(fc, {
        style: f => {
          const baseStyle = { ...STYLE[f.properties.status] };
          if (f.properties.status === "half") {
            // Orange hatched pattern
            baseStyle.fillColor = "url(#stripe-orange)";
            baseStyle.fill = true;
          } else if (f.properties.status === "full") {
            // Green hatched pattern
            baseStyle.fillColor = "url(#stripe-green)";
            baseStyle.fill = true;
          }
          // apply selection highlight
          if (selectedLayers && selectedLayers.has(f.properties.id)) {
            baseStyle.weight = Math.max(baseStyle.weight || 2, 3);
            baseStyle.color = "#fbbf24";
          }
          return baseStyle;
        },
        onEachFeature: (f, lyr) => {
          // Tek sol tık: kademe arttır (drag modda değilse)
          // Ctrl+Click toggles selection for submit
          lyr.on("click", (e) => {
            if (modeRef.current) return;
            if (e.originalEvent?.button !== 0) return;
            e.originalEvent.stopPropagation();
            const id = f.properties.id;
            const isSelectToggle = e.originalEvent?.ctrlKey || e.originalEvent?.metaKey;
            if (isSelectToggle) {
              // Only allow selecting features that are DONE (full/green)
              if (f.properties.status !== "full") {
                return; // ignore selection for non-full features
              }
              const next = new Set(selectedLayers);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              setSelectedLayers(next);
              // visual update
              const selected = next.has(id);
              lyr.setStyle({
                ...STYLE[f.properties.status],
                weight: selected ? 4 : (f.properties.status === "todo" ? 2 : 3),
                color: selected ? "#fbbf24" : STYLE[f.properties.status].color
              });
              return;
            }
            advanceOneStep(lyr, false);
          });

          // Tek sağ tık: 0%
          lyr.on("contextmenu", (e) => {
            e.originalEvent.preventDefault();
            e.originalEvent.stopPropagation?.();
            if (modeRef.current) return;
            eraseOne(lyr, false);
          });

          // Sadece tuş basılıyken hızlı modlar
          lyr.on("mouseover", () => {
            if (modeRef.current === "paint" && (buttonsRef.current & 1)) {
              advanceOneStep(lyr, true);
            } else if (modeRef.current === "erase" && (buttonsRef.current & 2)) {
              eraseOne(lyr, true);
            }
          });

          // Görsel hover
          lyr.on("mouseover", () => {
            const sel = selectedLayers.has(f.properties.id);
            const baseStyle = { ...STYLE[f.properties.status] };
            baseStyle.weight = sel ? 4 : (f.properties.status === "todo" ? 2 : 3);
            if (f.properties.status === "half") {
              baseStyle.fillColor = "url(#stripe-orange)";
              baseStyle.fill = true;
            } else if (f.properties.status === "full") {
              baseStyle.fillColor = "url(#stripe-green)";
              baseStyle.fill = true;
            }
            if (sel) baseStyle.color = "#fbbf24";
            lyr.setStyle(baseStyle);
          });
          lyr.on("mouseout", () => {
            const sel = selectedLayers.has(f.properties.id);
            const baseStyle = { ...STYLE[f.properties.status] };
            if (f.properties.status === "half") {
              baseStyle.fillColor = "url(#stripe-orange)";
              baseStyle.fill = true;
            } else if (f.properties.status === "full") {
              baseStyle.fillColor = "url(#stripe-green)";
              baseStyle.fill = true;
            }
            if (sel) {
              baseStyle.weight = 3;
              baseStyle.color = "#fbbf24";
            }
            lyr.setStyle(baseStyle);
          });
        }
      }).addTo(map);

      geoRef.current = layer;

      if (!fitDone.current) {
        const b = layer.getBounds();
        if (b.isValid()) {
          map.fitBounds(b.pad(0.1), { animate: false });
          fitDone.current = true;
        }
      }

      // Map container events: mod ve buttons takibi
      const el = map.getContainer();
      const preventCtx = (e) => e.preventDefault();
      el.addEventListener("contextmenu", preventCtx);

      const onMouseDown = (e) => {
        buttonsRef.current = e.buttons || 0;
        if (e.button === 0) modeRef.current = "paint";
        else if (e.button === 2) modeRef.current = "erase";
        else return;

        paintedThisDragRef.current = new Set();
        erasedThisDragRef.current = new Set();

        map.dragging.disable();
        el.style.cursor = "crosshair";
      };

      const onMouseMove = (e) => {
        buttonsRef.current = e.buttons || 0;
        if (buttonsRef.current === 0 && modeRef.current) endDrag();
      };

      const endDrag = () => {
        modeRef.current = null;
        buttonsRef.current = 0;
        paintedThisDragRef.current.clear();
        erasedThisDragRef.current.clear();
        map.dragging.enable();
        el.style.cursor = "";
      };

      el.addEventListener("mousedown", onMouseDown);
      el.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", endDrag);

      return () => {
        el.removeEventListener("contextmenu", preventCtx);
        el.removeEventListener("mousedown", onMouseDown);
        el.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", endDrag);
        if (geoRef.current) {
          geoRef.current.removeFrom(map);
          geoRef.current = null;
        }
      };
    }, [fc, map, selectedLayers]);

    return null;
  }

  const handleResetConfirm = () => {
    if (!geoRef.current) return;
    geoRef.current.eachLayer(l => {
      l.feature.properties.status = "todo";
      l.setStyle(STYLE.todo);
      l.unbindTooltip();
    });
    setStats(p => ({ ...p, half: 0, full: 0 }));
    setSelectedLayers(new Set());
    setShowResetConfirm(false);
  };

  const reset = () => {
    setShowResetConfirm(true);
  };

  const exportToExcel = () => {
    // Gather table data
    const tableData = [];
    if (geoRef.current) {
      geoRef.current.eachLayer(l => {
        tableData.push({
          ID: l.feature.properties.id,
          Status: l.feature.properties.status,
          Percentage: l.feature.properties.status === "half" ? "50%" : 
                      l.feature.properties.status === "full" ? "100%" : "0%"
        });
      });
    }

    // Create workbook
    const wb = XLSX.utils.book_new();
    
    // Sheet 1: Summary
    // Work Amount should reflect the number of DONE tables (full)
    const workAmount = stats.full || 0;
    // Keep selectedIds for marking selected rows (Ctrl+Click selection)
    const selectedIds = selectedLayers ? Array.from(selectedLayers) : [];

    const summaryData = [
      ["Summary Information"],
      ["Contractor Name", formData.contractor],
      ["Date", formData.date],
      ["Number of Workers", formData.workers],
      ["Work Amount", workAmount],
      [],
      ["Statistics"],
      ["Total Tables", stats.total],
      ["Done Tables", stats.full],
      ["Ongoing Tables", stats.half],
      ["Remaining Tables", stats.total - stats.half - stats.full],
      ["Completion %", percentFull.toFixed(2) + "%"],
      ["Ongoing %", percentHalf.toFixed(2) + "%"]
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, ws1, "Summary");

    // Sheet 2: Table Details
    // Mark selected rows in details
    const detailed = tableData.map(r => ({ ...r, Selected: selectedIds.includes(r.ID) ? "YES" : "" }));
    const ws2 = XLSX.utils.json_to_sheet(detailed);
    XLSX.utils.book_append_sheet(wb, ws2, "Table Details");

    // Download
    const safeContractor = (formData.contractor || "contractor").replace(/[^a-z0-9_-]/gi, "_");
    const filename = `Tables_${formData.date}_${safeContractor}.xlsx`;
    XLSX.writeFile(wb, filename);
    
    setShowSubmitModal(false);
    setFormData({
      contractor: "",
      date: new Date().toISOString().split("T")[0],
      workers: ""
    });
  };

  // Save submission into memory (and localStorage)
  const saveSubmission = () => {
    const entry = {
      contractor: formData.contractor,
      date: formData.date,
      workers: formData.workers,
      workAmount: stats.full || 0,
      selectedIds: selectedLayers ? Array.from(selectedLayers) : [],
      stats: { ...stats }
    };
    const next = [...submissions, entry];
    setSubmissions(next);
    try { localStorage.setItem("submissions", JSON.stringify(next)); } catch (e) {}
    setShowSubmitModal(false);
    setFormData({ contractor: "", date: new Date().toISOString().split("T")[0], workers: "" });
  };

  // Export a saved submission (if provided) or fallback to current export
  const exportSubmissionToExcel = (submission) => {
    if (!submission) return exportToExcel();

    const tableData = [];
    if (geoRef.current) {
      geoRef.current.eachLayer(l => {
        tableData.push({
          ID: l.feature.properties.id,
          Status: l.feature.properties.status,
          Percentage: l.feature.properties.status === "half" ? "50%" : (l.feature.properties.status === "full" ? "100%" : "0%")
        });
      });
    }

    const wb = XLSX.utils.book_new();
    const summaryData = [
      ["Summary Information"],
      ["Contractor Name", submission.contractor],
      ["Date", submission.date],
      ["Number of Workers", submission.workers],
      ["Work Amount", submission.workAmount],
      [],
      ["Statistics"],
      ["Total Tables", submission.stats.total],
      ["Done Tables", submission.stats.full],
      ["Ongoing Tables", submission.stats.half],
      ["Remaining Tables", submission.stats.total - submission.stats.half - submission.stats.full],
      ["Completion %", pct(submission.stats.full, submission.stats.total).toFixed(2) + "%"],
      ["Ongoing %", pct(submission.stats.half, submission.stats.total).toFixed(2) + "%"]
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, ws1, "Summary");

    const detailed = tableData.map(r => ({ ...r, Selected: submission.selectedIds.includes(r.ID) ? "YES" : "" }));
    const ws2 = XLSX.utils.json_to_sheet(detailed);
    XLSX.utils.book_append_sheet(wb, ws2, "Table Details");

    const safeContractor = (submission.contractor || "contractor").replace(/[^a-z0-9_-]/gi, "_");
    const filename = `Tables_${submission.date}_${safeContractor}.xlsx`;
    XLSX.writeFile(wb, filename);
  };

  const percentFull = pct(stats.full, stats.total);
  const percentHalf = pct(stats.half, stats.total);
  const remaining = stats.total - stats.half - stats.full;

  return (
    <div className="app-shell">
      <div className="header">
        <div className="statsbar">
          {/* Total */}
          <div className="stat-item">
            <span className="stat-label">Total:</span>
            <span className="stat-value">{stats.total}</span>
          </div>

          {/* Done: Sayı, Yüzde */}
          <div className="stat-item">
            <span className="stat-label">Done:</span>
            <span className="stat-value">{stats.full}, <span className="stat-percentage-inline">%{(percentFull / 100).toFixed(2)}</span></span>
          </div>

          {/* Ongoing: Sayı, Yüzde */}
          <div className="stat-item">
            <span className="stat-label">Ongoing:</span>
            <span className="stat-value">{stats.half}, <span className="stat-percentage-inline">%{(percentHalf / 100).toFixed(2)}</span></span>
          </div>

          {/* Remaining */}
          <div className="stat-item">
            <span className="stat-label">Remaining:</span>
            <span className="stat-value">{remaining}</span>
          </div>

        </div>

        {/* Centered app title inside header */}
        <div className="top-title">Table Installation Progress Tracking</div>

        {/* Actions aligned to right: Submit | Export | Reset */}
        <div className="header-actions">
          <button onClick={() => setShowSubmitModal(true)} style={{ padding: "6px 12px", borderRadius: 6 }}>
            Submit Daily Work
          </button>
          <button onClick={() => { if (submissions && submissions.length) exportSubmissionToExcel(submissions[submissions.length-1]); else exportToExcel(); }} style={{ padding: "6px 12px", borderRadius: 6 }}>
            Export
          </button>
          <button onClick={reset} style={{ padding: "6px 12px", borderRadius: 6 }}>
            Reset All
          </button>
        </div>
      </div>

      {/* Reset Confirmation Dialog */}
      {showResetConfirm && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>Confirm Reset</h2>
            <p>Are you sure you want to reset all tables?</p>
            <div className="modal-actions">
              <button onClick={handleResetConfirm}>Yes, Reset</button>
              <button onClick={() => setShowResetConfirm(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Submit Modal */}
      {showSubmitModal && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>Daily Work Report</h2>
            <div className="form-group">
              <label>Contractor Name:</label>
              <input
                type="text"
                value={formData.contractor}
                onChange={(e) => setFormData({...formData, contractor: e.target.value})}
                placeholder="Enter contractor name"
              />
            </div>
            <div className="form-group">
              <label>Date:</label>
              <input
                type="date"
                value={formData.date}
                onChange={(e) => setFormData({...formData, date: e.target.value})}
              />
            </div>
            <div className="form-group">
              <label>Number of Workers:</label>
              <input
                type="number"
                value={formData.workers}
                onChange={(e) => setFormData({...formData, workers: e.target.value})}
                placeholder="Enter number of workers"
                min="1"
              />
            </div>
            <div className="form-group">
              <label>Work Amount (done count):</label>
              <div style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#f9fafb' }}>
                {stats.full}
              </div>
            </div>
            {/* Note: selection must be DONE (green) to be counted. Use Ctrl+Click on finished tables to select. */}
            <div className="form-group">
              <div style={{ color: '#6b7280', fontSize: 13 }}>Select only tables that are DONE (green) using Ctrl+Click; only selected DONE tables are counted.</div>
            </div>
            <div className="modal-actions">
              <button onClick={() => { saveSubmission(); }}>Submit</button>
              <button onClick={() => setShowSubmitModal(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="map-wrap">
        <MapContainer
          center={[52.5, -1.9]}
          zoom={17}
          zoomControl={true}
          doubleClickZoom={false}
          style={{ height: "100%", width: "100%" }}   // ← ekledik
        >
          <svg style={{ position: "absolute", width: 0, height: 0 }}>
            <defs>
              <pattern id="stripe-orange" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(-45)">
                <line x1="0" y1="0" x2="0" y2="8" stroke="#b45309" strokeWidth="4" />
              </pattern>
              <pattern id="stripe-green" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(-45)">
                <line x1="0" y1="0" x2="0" y2="8" stroke="#047857" strokeWidth="4" />
              </pattern>
            </defs>
          </svg>

          {data && <Layer fc={data} />}
        </MapContainer>
      </div>
    </div>
  );
}
