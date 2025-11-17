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
          return baseStyle;
        },
        onEachFeature: (f, lyr) => {
          // Tek sol tık: kademe arttır (drag modda değilse)
          lyr.on("click", (e) => {
            if (modeRef.current) return;
            if (e.originalEvent?.button !== 0) return;
            e.originalEvent.stopPropagation();
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
            const baseStyle = { ...STYLE[f.properties.status] };
            baseStyle.weight = f.properties.status === "todo" ? 2 : 3;
            if (f.properties.status === "half") {
              baseStyle.fillColor = "url(#stripe-orange)";
              baseStyle.fill = true;
            } else if (f.properties.status === "full") {
              baseStyle.fillColor = "url(#stripe-green)";
              baseStyle.fill = true;
            }
            lyr.setStyle(baseStyle);
          });
          lyr.on("mouseout", () => {
            const baseStyle = { ...STYLE[f.properties.status] };
            if (f.properties.status === "half") {
              baseStyle.fillColor = "url(#stripe-orange)";
              baseStyle.fill = true;
            } else if (f.properties.status === "full") {
              baseStyle.fillColor = "url(#stripe-green)";
              baseStyle.fill = true;
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
    const summaryData = [
      ["Summary Information"],
      ["Contractor Name", formData.contractor],
      ["Date", formData.date],
      ["Number of Workers", formData.workers],
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
    const ws2 = XLSX.utils.json_to_sheet(tableData);
    XLSX.utils.book_append_sheet(wb, ws2, "Table Details");

    // Download
    const filename = `Tables_${formData.date}_${formData.contractor}.xlsx`;
    XLSX.writeFile(wb, filename);
    
    setShowSubmitModal(false);
    setFormData({
      contractor: "",
      date: new Date().toISOString().split("T")[0],
      workers: ""
    });
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

          <div className="header-actions">
            <button onClick={() => setShowSubmitModal(true)} style={{ padding: "4px 10px", borderRadius: 6 }}>
              Submit
            </button>
            <button onClick={reset} style={{ padding: "4px 10px", borderRadius: 6 }}>
              Reset All
            </button>
          </div>
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
            <h2>Submit Work Report</h2>
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
            <div className="modal-actions">
              <button onClick={exportToExcel}>Export to Excel</button>
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
