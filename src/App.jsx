import React, { useEffect, useState, useRef } from "react";
import { MapContainer, useMap } from "react-leaflet";
import L from "leaflet";
import * as XLSX from "xlsx";
import { Chart, registerables } from "chart.js";
import ChartDataLabels from "chartjs-plugin-datalabels";
import ExcelJS from "exceljs";

Chart.register(...registerables);
Chart.register(ChartDataLabels);

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
  const [tableTypes, setTableTypes] = useState({ t27: 0, t54: 0 });
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
  const selectedLayersRef = useRef(new Set());
  const chartRef = useRef(null);
  const chartCanvasRef = useRef(null);

  // Drag / selection box durumu
  const dragStartRef = useRef(null); // {x,y} client pixels
  
  // Keep ref in sync with state
  useEffect(() => {
    selectedLayersRef.current = selectedLayers;
  }, [selectedLayers]);

  // Cleanup chart on unmount
  useEffect(() => {
    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
      }
    };
  }, []);


  useEffect(() => {
    fetch("/tables.geojson")
      .then(r => r.json())
      .then(fc => {
        // Masa tiplerini say
        let c27 = 0, c54 = 0;

        fc.features.forEach((f, i) => {
          const layer = f.properties.layer;

          if (layer === "panels_27") c27++;
          if (layer === "panels_54") c54++;

          // LineString olarak gelen masaları Polygon'a çevir ki tüm yüzey tıklanabilir olsun
          if (f.geometry && f.geometry.type === "LineString") {
            const coords = f.geometry.coordinates;
            if (Array.isArray(coords) && coords.length >= 4) {
              f.geometry = {
                type: "Polygon",
                coordinates: [coords]
              };
            }
          }
          f.properties.id = f.properties.id || `F${i}`;
          f.properties.status = f.properties.status || "todo";
        });
        // state’e işle
        setTableTypes({ t27: c27, t54: c54 });
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

  // n: done/ongoing sayısı, d: toplam => yüzde (0-100)
  const pct = (n, d) => (d ? (n * 100) / d : 0);

  function Layer({ fc }) {
    const map = useMap();

    const advanceOneStep = (lyr) => {
      if (!lyr) return;

      const cur = lyr.feature.properties.status || "todo";
      if (cur === "todo") setLayerStatus(lyr, "half");
      else if (cur === "half") setLayerStatus(lyr, "full");
      else return;
      updateStats();
    };

    const eraseOne = (lyr) => {
      if (!lyr) return;

      if (lyr.feature.properties.status !== "todo") {
        setLayerStatus(lyr, "todo");
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
          return baseStyle;
        },
        onEachFeature: (f, lyr) => {
          // Tek sol tık: kademe arttır (drag modda değilse)
          // Ctrl+Click toggles selection for submit
          lyr.on("click", (e) => {
            if (e.originalEvent?.button !== 0) return;
            e.originalEvent.stopPropagation();
            // Normal click: advance status (todo -> half -> full)
            advanceOneStep(lyr);
          });

          // Tek sağ tık: 0%
          lyr.on("contextmenu", (e) => {
            e.originalEvent.preventDefault();
            e.originalEvent.stopPropagation?.();
            eraseOne(lyr);
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

      // Seçim kutusu için basit bir overlay div'i
      let selectionBoxDiv = null;

      const ensureSelectionBoxDiv = () => {
        if (selectionBoxDiv) return selectionBoxDiv;
        const div = document.createElement("div");
        div.style.position = "absolute";
        div.style.border = "2px dashed #2563eb";
        div.style.backgroundColor = "rgba(37,99,235,0.15)";
        div.style.pointerEvents = "none";
        div.style.zIndex = 999;
        div.style.display = "none";
        el.appendChild(div);
        selectionBoxDiv = div;
        return div;
      };

      const hideSelectionBox = () => {
        if (selectionBoxDiv) selectionBoxDiv.style.display = "none";
      };

      const onMouseDown = (e) => {
        // 0: sol (select / advance), 2: sağ (unselect / erase)
        if (e.button !== 0 && e.button !== 2) return;
        dragStartRef.current = { x: e.clientX, y: e.clientY, button: e.button };
        const rect = el.getBoundingClientRect();
        const box = ensureSelectionBoxDiv();
        box.style.left = `${e.clientX - rect.left}px`;
        box.style.top = `${e.clientY - rect.top}px`;
        box.style.width = "0px";
        box.style.height = "0px";
        box.style.display = "block";
        map.dragging.disable();
      };

      const onMouseMove = (e) => {
        if (!dragStartRef.current) return;
        const rect = el.getBoundingClientRect();
        const startX = dragStartRef.current.x - rect.left;
        const startY = dragStartRef.current.y - rect.top;
        const curX = e.clientX - rect.left;
        const curY = e.clientY - rect.top;

        const left = Math.min(startX, curX);
        const top = Math.min(startY, curY);
        const width = Math.abs(curX - startX);
        const height = Math.abs(curY - startY);

        const box = ensureSelectionBoxDiv();
        box.style.left = `${left}px`;
        box.style.top = `${top}px`;
        box.style.width = `${width}px`;
        box.style.height = `${height}px`;
      };

      const onMouseUp = (e) => {
        const start = dragStartRef.current;
        dragStartRef.current = null;
        map.dragging.enable();
        hideSelectionBox();

        if (!start) return;

        // Çok küçük hareketse: normal tık gibi kalsın (hiçbir şey yapma)
        const dx = Math.abs(e.clientX - start.x);
        const dy = Math.abs(e.clientY - start.y);
        if (dx < 5 && dy < 5) return;

        const rect = el.getBoundingClientRect();
        const startPt = L.point(start.x - rect.left, start.y - rect.top);
        const endPt = L.point(e.clientX - rect.left, e.clientY - rect.top);

        const minX = Math.min(startPt.x, endPt.x);
        const maxX = Math.max(startPt.x, endPt.x);
        const minY = Math.min(startPt.y, endPt.y);
        const maxY = Math.max(startPt.y, endPt.y);

        const sw = map.containerPointToLatLng(L.point(minX, maxY));
        const ne = map.containerPointToLatLng(L.point(maxX, minY));
        const bounds = L.latLngBounds(sw, ne);

        if (!geoRef.current) return;

        const isRightButton = start.button === 2;

        geoRef.current.eachLayer((lyr) => {
          if (!lyr.getBounds) return;

          // Merkeze göre değil, masanın alanı kutuyla kesişiyor mu ona bak
          const lb = lyr.getBounds();
          if (!bounds.intersects(lb)) return;

          if (isRightButton) {
            // Sağ tuş: sanki tek tek sağ tıklıyormuş gibi reset
            eraseOne(lyr);
          } else {
            // Sol tuş: sanki tek tek sol tıklıyormuş gibi kademe arttır
            advanceOneStep(lyr);
          }
        });
      };

      el.addEventListener("mousedown", onMouseDown);
      el.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);

      return () => {
        el.removeEventListener("contextmenu", preventCtx);
        el.removeEventListener("mousedown", onMouseDown);
        el.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        if (selectionBoxDiv && selectionBoxDiv.parentNode) {
          selectionBoxDiv.parentNode.removeChild(selectionBoxDiv);
          selectionBoxDiv = null;
        }
        if (geoRef.current) {
          geoRef.current.removeFrom(map);
          geoRef.current = null;
        }
      };
    }, [fc, map]);

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
    // Clear all localStorage data
    setSubmissions([]);
    try { 
      localStorage.removeItem("submissions");
      // Clear all localStorage if needed
      localStorage.clear();
    } catch (e) {
      console.error("Error clearing localStorage:", e);
    }
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
    // Work Amount = number of DONE (green/full) tables
    const workAmount = stats.full || 0;
    
    const entry = {
      contractor: formData.contractor,
      date: formData.date,
      workers: formData.workers,
      workAmount: workAmount,
      stats: { ...stats }
    };
    const next = [...submissions, entry];
    setSubmissions(next);
    try { localStorage.setItem("submissions", JSON.stringify(next)); } catch (e) {}
    setShowSubmitModal(false);
    setFormData({ contractor: "", date: new Date().toISOString().split("T")[0], workers: "" });
  };

  // Export all daily submissions to Excel - Group by date and sum work amounts, with chart
  const exportAllSubmissionsToExcel = async () => {
    if (!submissions || submissions.length === 0) {
      alert("No daily work records found. Please submit at least one daily work report.");
      return;
    }

    // Group submissions by date
    const dateGroups = {};
    submissions.forEach(sub => {
      const date = sub.date || "-";
      if (!dateGroups[date]) {
        dateGroups[date] = {
          totalWorkAmount: 0,
          contractors: new Set(),
          workers: []
        };
      }
      dateGroups[date].totalWorkAmount += sub.workAmount || 0;
      if (sub.contractor) {
        dateGroups[date].contractors.add(sub.contractor);
      }
      if (sub.workers) {
        dateGroups[date].workers.push(sub.workers);
      }
    });
    
    // Prepare data for chart and Excel
    const sortedDates = Object.keys(dateGroups).sort();
    const chartData = sortedDates.map(date => {
      const group = dateGroups[date];
      const contractorsList = Array.from(group.contractors);
      const firstContractor = contractorsList[0] || "";
      const contractorShort = firstContractor.substring(0, 2).toUpperCase();
      const avgWorkers = group.workers.length > 0 
        ? Math.round(group.workers.reduce((sum, w) => sum + (parseInt(w) || 0), 0) / group.workers.length)
        : 0;
      
      return {
        date,
        workAmount: group.totalWorkAmount,
        contractors: contractorsList.join(", ") || "-",
        contractorShort,
        workers: avgWorkers
      };
    });

    // Create chart using Chart.js
    const canvas = chartCanvasRef.current;
    if (!canvas) {
      alert("Chart canvas not found. Please refresh the page.");
      return;
    }

    const ctx = canvas.getContext("2d");
    
    // Destroy previous chart if exists
    if (chartRef.current) {
      chartRef.current.destroy();
    }

    // Create new chart
    chartRef.current = new Chart(ctx, {
      type: "bar",
      data: {
        labels: chartData.map(d => d.date),
        datasets: [{
          label: "Work Amount",
          data: chartData.map(d => d.workAmount),
          backgroundColor: "rgba(37, 99, 235, 0.6)",
          borderColor: "rgba(37, 99, 235, 1)",
          borderWidth: 1,
          maxBarThickness: 50
        }]
      },
      plugins: [ChartDataLabels],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          datalabels: {
            anchor: "end",
            align: "top",
            formatter: (value, context) => {
              const data = chartData[context.dataIndex];
              return `${data.contractorShort}-${data.workers}`;
            },
            font: {
              size: 11,
              weight: "bold"
            },
            color: "#1f2937"
          },
          legend: {
            display: false
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            title: {
              display: true,
              text: "Work Amount",
              font: {
                size: 18,
                weight: "bold"
              },
              color: "#000000"
            },
            ticks: {
              font: {
                size: 16,
                weight: "bold"
              },
              color: "#000000"
            }
          },
          x: {
            title: {
              display: true,
              text: "Date",
              font: {
                size: 18,
                weight: "bold"
              },
              color: "#000000"
            },
            ticks: {
              maxRotation: 90,
              minRotation: 90,
              font: {
                size: 14,
                weight: "bold"
              },
              color: "#000000"
            }
          }
        },
        datasets: {
          bar: {
            categoryPercentage: 0.6,
            barPercentage: 0.9
          }
        },
        layout: {
          padding: {
            top: 5,
            bottom: 5,
            left: 5,
            right: 5
          }
        }
      }
    });

    // Wait a bit for chart to render
    await new Promise(resolve => setTimeout(resolve, 500));

    // Convert canvas to PNG
    const pngDataUrl = canvas.toDataURL("image/png");
    
    // Convert base64 to buffer
    const base64Data = pngDataUrl.replace(/^data:image\/png;base64,/, "");
    const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

    // Create Excel workbook with ExcelJS
    const workbook = new ExcelJS.Workbook();
    
    // Sheet 1: Data
    const dataSheet = workbook.addWorksheet("Daily Work Records");
    dataSheet.columns = [
      { header: "Date", key: "date", width: 15 },
      { header: "Contractor Name", key: "contractors", width: 30 },
      { header: "Work Amount", key: "workAmount", width: 15 }
    ];
    
    chartData.forEach(item => {
      dataSheet.addRow({
        date: item.date,
        contractors: item.contractors,
        workAmount: item.workAmount
      });
    });

    // Style header row
    dataSheet.getRow(1).font = { bold: true };
    dataSheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE5E7EB" }
    };

    // Sheet 2: Chart
    const chartSheet = workbook.addWorksheet("Chart");
    
    // Add image to chart sheet
    const imageId = workbook.addImage({
      buffer: bytes,
      extension: "png"
    });

    chartSheet.addImage(imageId, {
      tl: { col: 0, row: 0 },
      ext: { width: 900, height: 500 }
    });

    // Set column width for chart sheet
    chartSheet.getColumn(1).width = 120; // ~900px / 7.5

    // Download
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { 
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" 
    });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Daily_Work_Records_${new Date().toISOString().split("T")[0]}.xlsx`;
    link.click();
    window.URL.revokeObjectURL(url);
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
      {/* Hidden canvas for chart generation */}
      <canvas 
        ref={chartCanvasRef}
        id="chartCanvas" 
        width="900" 
        height="500" 
        style={{ position: "absolute", left: "-9999px" }}
      />
      <div className="header">
        <div className="statsbar">
          <div className="panel-stats">
            <div className="stat-item">
              <span className="stat-label">Table_27:</span>
              <span className="stat-value">{tableTypes.t27}</span>
            </div>

            <div className="stat-item">
              <span className="stat-label">Table_54:</span>
              <span className="stat-value">{tableTypes.t54}</span>
            </div>
          </div>

          <div className="status-stats">
            {/* Done: Sayı, Yüzde */}
            <div className="stat-item done">
              <span className="stat-label">Done:</span>
              <span className="stat-value">{stats.full}, <span className="stat-percentage-inline">%{percentFull.toFixed(2)}</span></span>
            </div>

            {/* Ongoing: Sayı, Yüzde */}
            <div className="stat-item ongoing">
              <span className="stat-label">Ongoing:</span>
              <span className="stat-value">{stats.half}, <span className="stat-percentage-inline">%{percentHalf.toFixed(2)}</span></span>
            </div>
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
          <button onClick={exportAllSubmissionsToExcel} style={{ padding: "6px 12px", borderRadius: 6 }}>
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
              <label>Work Amount (completed/done tables):</label>
              <div style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#f9fafb', fontWeight: 'bold', fontSize: '18px', color: '#1f2937', textAlign: 'center' }}>
                {stats.full || 0}
              </div>
            </div>
            <div className="form-group">
              <div style={{ color: '#6b7280', fontSize: 13 }}>Work Amount shows the number of tables marked as DONE (green). Click once for ongoing (orange), click again for done (green).</div>
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
