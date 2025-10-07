import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./FunctionTracerViewer.css";

const ITEM_HEIGHT = 56;
const OVERSCAN = 6;

const TYPE_LABELS = {
  enter: "Enter",
  exit: "Exit",
  log: "Log",
};

const colors = {
  enter: "#2563eb",
  exit: "#dc2626",
  log: "#0891b2",
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const formatDuration = (ms) => {
  if (ms === null || ms === undefined || Number.isNaN(ms)) {
    return "-";
  }
  if (Math.abs(ms) < 1) {
    return `${ms.toFixed(2)}ms`;
  }
  if (Math.abs(ms) < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (Math.abs(seconds) < 60) {
    return `${seconds.toFixed(2)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = (seconds % 60).toFixed(1);
  return `${minutes}m ${remaining}s`;
};

const formatTimestamp = (value) => {
  if (!value) return "-";
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value.toString();
    }
    return date.toLocaleString();
  } catch (error) {
    return value.toString();
  }
};

const highlight = (text, term) => {
  if (!term) return text;
  const safeTerm = escapeRegExp(term.trim());
  if (!safeTerm) return text;
  const regex = new RegExp(`(${safeTerm})`, "ig");
  const parts = text.split(regex);
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <mark key={`${part}-${index}`} className="ftv-highlight">
        {part}
      </mark>
    ) : (
      <span key={`${part}-${index}`}>{part}</span>
    )
  );
};

const buildItemId = (item, index) => `${item.t}-${item.fn}-${index}`;

const enrichTrace = (trace) => {
  if (!trace?.length) return [];
  let prev = null;
  const firstTimestamp = trace[0].t ?? trace[0].timestamp ?? 0;
  const lastTimestamp = trace[trace.length - 1].t ?? trace[trace.length - 1].timestamp ?? firstTimestamp;
  const totalSpan = Math.max(1, lastTimestamp - firstTimestamp);

  return trace.map((item, index) => {
    const timestamp = item.t ?? item.timestamp ?? 0;
    const delta = prev ? timestamp - (prev.t ?? prev.timestamp ?? 0) : null;
    prev = item;
    return {
      ...item,
      __id: buildItemId(item, index),
      __index: index,
      __relative: timestamp - firstTimestamp,
      __delta: delta,
      __percent: ((timestamp - firstTimestamp) / totalSpan) * 100,
    };
  });
};

const calculateSummary = (items) => {
  if (!items.length) {
    return {
      span: 0,
      total: 0,
      uniqueFns: 0,
      maxDepth: 0,
    };
  }
  const first = items[0];
  const last = items[items.length - 1];
  const depths = items.map((item) => item.depth ?? 0);
  return {
    span: (last.t ?? last.timestamp ?? 0) - (first.t ?? first.timestamp ?? 0),
    total: items.length,
    uniqueFns: new Set(items.map((item) => item.fn)).size,
    maxDepth: Math.max(...depths, 0),
  };
};

const computeVirtualWindow = (items, containerHeight, scrollTop) => {
  const start = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
  const end = Math.min(
    items.length,
    Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + OVERSCAN
  );
  const slice = items.slice(start, end);
  return {
    items: slice,
    offset: start * ITEM_HEIGHT,
    totalHeight: items.length * ITEM_HEIGHT,
  };
};

const groupByType = (items) => {
  const counts = new Map();
  items.forEach((item) => {
    const key = item.type ?? "other";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
};

const createDefaultFilters = () => ({
  search: "",
  types: new Set(),
  depthMin: "",
  depthMax: "",
});

const filterItems = (items, filters) => {
  const { search, types, depthMin, depthMax } = filters;
  const safeSearch = search.trim().toLowerCase();
  const hasTypes = types.size > 0;
  const minDepth = depthMin === "" ? Number.NEGATIVE_INFINITY : Number(depthMin);
  const maxDepth = depthMax === "" ? Number.POSITIVE_INFINITY : Number(depthMax);

  return items.filter((item) => {
    if (item.depth !== undefined) {
      if (item.depth < minDepth || item.depth > maxDepth) {
        return false;
      }
    }

    if (hasTypes && !types.has(item.type)) {
      return false;
    }

    if (!safeSearch) return true;

    const target = `${item.fn ?? ""} ${item.file ?? ""} ${item.type ?? ""}`.toLowerCase();
    return target.includes(safeSearch);
  });
};

const SummaryCard = ({ label, value, hint }) => (
  <article className="ftv-card">
    <p className="ftv-card-label">{label}</p>
    <p className="ftv-card-value">{value}</p>
    {hint ? <p className="ftv-card-hint">{hint}</p> : null}
  </article>
);

const TypeToggle = ({ type, count, active, onToggle }) => (
  <button
    type="button"
    className={`ftv-type-toggle ${active ? "is-active" : ""}`}
    onClick={() => onToggle(type)}
  >
    <span
      className="ftv-type-dot"
      style={{ backgroundColor: colors[type] ?? "#6b7280" }}
    />
    <span className="ftv-type-name">{TYPE_LABELS[type] ?? type}</span>
    <span className="ftv-type-count">{count}</span>
  </button>
);

const DetailPanel = ({ item }) => {
  if (!item) {
    return (
      <aside className="ftv-detail is-empty">
        <h3>Trace details</h3>
        <p>Select a row to inspect its metadata, timings, and context.</p>
      </aside>
    );
  }

  return (
    <aside className="ftv-detail">
      <header className="ftv-detail-header">
        <span className={`ftv-pill type-${item.type}`}>
          {TYPE_LABELS[item.type] ?? item.type ?? "event"}
        </span>
        <h3>{item.fn ?? "Unknown function"}</h3>
        {item.file ? <p className="ftv-detail-file">{item.file}</p> : null}
      </header>

      <dl className="ftv-detail-grid">
        <div>
          <dt>Absolute time</dt>
          <dd>{formatTimestamp(item.t ?? item.timestamp)}</dd>
        </div>
        <div>
          <dt>Relative (from start)</dt>
          <dd>{formatDuration(item.__relative)}</dd>
        </div>
        <div>
          <dt>Δ from previous</dt>
          <dd>{formatDuration(item.__delta)}</dd>
        </div>
        <div>
          <dt>Depth</dt>
          <dd>{item.depth ?? "-"}</dd>
        </div>
        {item.line !== undefined && item.line !== null ? (
          <div>
            <dt>Line</dt>
            <dd>{item.line}</dd>
          </div>
        ) : null}
      </dl>

      <section className="ftv-detail-extra">
        <h4>Raw payload</h4>
        <pre>{JSON.stringify(item, null, 2)}</pre>
      </section>
    </aside>
  );
};

const TraceRow = ({ item, isSelected, onSelect, searchTerm, span }) => {
  const percent = Math.min(100, Math.max(0, item.__percent ?? 0));
  const indent = Math.min(24, item.depth ?? 0) * 12;
  const delta = item.__delta;
  const deltaPercent =
    span > 0 && typeof delta === "number"
      ? Math.min(100, Math.max(0, (delta / span) * 100))
      : null;
  const timelineLeft = `${percent}%`;

  return (
    <button
      type="button"
      className={`ftv-row ${isSelected ? "is-selected" : ""}`}
      onClick={() => onSelect(item)}
    >
      <span className="ftv-row-index">#{item.__index + 1}</span>
      <span className="ftv-row-summary">
        <span className="ftv-row-title" style={{ paddingLeft: `${indent}px` }}>
          <span className={`ftv-pill type-${item.type}`}>{(item.type ?? "").slice(0, 1).toUpperCase()}</span>
          <span className="ftv-row-fn">{highlight(item.fn ?? "Anonymous", searchTerm)}</span>
        </span>
        <span className="ftv-row-meta">
          {item.file ? <span className="ftv-row-file">{highlight(item.file, searchTerm)}</span> : null}
          {item.line !== undefined && item.line !== null ? (
            <span className="ftv-row-line">:{item.line}</span>
          ) : null}
        </span>
      </span>
      <span className="ftv-row-timings">
        <span className="ftv-row-relative">{formatDuration(item.__relative)}</span>
        <span className="ftv-row-delta">+{formatDuration(delta)}</span>
        <span className="ftv-row-depth">d{item.depth ?? "-"}</span>
        <span className="ftv-row-timeline">
          <span className="ftv-row-timeline-track" />
          <span className="ftv-row-timeline-dot" style={{ left: timelineLeft }} />
          {typeof deltaPercent === "number" ? (
            <span
              className="ftv-row-timeline-bar"
              style={{
                width: `${deltaPercent}%`,
                backgroundColor: colors[item.type] ?? "#6366f1",
              }}
            />
          ) : null}
        </span>
      </span>
    </button>
  );
};

const FunctionTracerViewer = ({ trace = [], defaultSelectedIndex = 0, onSelect }) => {
  const enriched = useMemo(() => enrichTrace(trace), [trace]);
  const summary = useMemo(() => calculateSummary(enriched), [enriched]);
  const groupedTypes = useMemo(() => groupByType(enriched), [enriched]);

  const [filters, setFilters] = useState(() => createDefaultFilters());
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(480);
  const [selectedId, setSelectedId] = useState(() => {
    const target = enriched[defaultSelectedIndex];
    return target ? target.__id : null;
  });

  const containerRef = useRef(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;
    const updateHeight = () => {
      setContainerHeight(node.clientHeight || 480);
    };
    updateHeight();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateHeight);
      observer.observe(node);
      window.addEventListener("resize", updateHeight);
      return () => {
        observer.disconnect();
        window.removeEventListener("resize", updateHeight);
      };
    }

    window.addEventListener("resize", updateHeight);
    return () => window.removeEventListener("resize", updateHeight);
  }, []);

  useEffect(() => {
    setSelectedId((prev) => {
      if (prev) return prev;
      const first = enriched[defaultSelectedIndex];
      return first ? first.__id : null;
    });
  }, [defaultSelectedIndex, enriched]);

  const filteredItems = useMemo(
    () => filterItems(enriched, filters),
    [enriched, filters]
  );

  const { items: visibleItems, offset, totalHeight } = useMemo(
    () => computeVirtualWindow(filteredItems, containerHeight, scrollTop),
    [filteredItems, containerHeight, scrollTop]
  );

  const selectedItem = useMemo(
    () => filteredItems.find((item) => item.__id === selectedId),
    [filteredItems, selectedId]
  );

  useEffect(() => {
    if (!filteredItems.length) {
      setSelectedId(null);
      return;
    }
    setSelectedId((prev) => {
      if (prev && filteredItems.some((item) => item.__id === prev)) {
        return prev;
      }
      return filteredItems[0].__id;
    });
  }, [filteredItems]);

  const handleScroll = useCallback((event) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const updateFilter = useCallback((key, value) => {
    setFilters((prev) => {
      if (key === "types") {
        return {
          ...prev,
          types: value,
        };
      }
      return {
        ...prev,
        [key]: value,
      };
    });
  }, []);

  const handleTypeToggle = useCallback(
    (type) => {
      setFilters((prev) => {
        const nextTypes = new Set(prev.types);
        if (nextTypes.has(type)) {
          nextTypes.delete(type);
        } else {
          nextTypes.add(type);
        }
        return {
          ...prev,
          types: nextTypes,
        };
      });
    },
    []
  );

  const handleSelect = useCallback(
    (item) => {
      setSelectedId(item.__id);
      onSelect?.(item);
    },
    [onSelect]
  );

  const clearFilters = useCallback(() => {
    setFilters(createDefaultFilters());
  }, []);

  return (
    <section className="ftv">
      <header className="ftv-header">
        <SummaryCard
          label="Trace length"
          value={formatDuration(summary.span)}
          hint="Total recorded span"
        />
        <SummaryCard
          label="Events"
          value={summary.total}
          hint={`${filteredItems.length} visible after filters`}
        />
        <SummaryCard
          label="Unique functions"
          value={summary.uniqueFns}
          hint="Across the entire trace"
        />
        <SummaryCard label="Max depth" value={summary.maxDepth} />
      </header>

      <section className="ftv-controls">
        <div className="ftv-search">
          <label>
            <span>Search</span>
            <input
              type="search"
              placeholder="Filter by function, file, or type"
              value={filters.search}
              onChange={(event) => updateFilter("search", event.target.value)}
            />
          </label>
        </div>

        <div className="ftv-depth">
          <label>
            <span>Depth from</span>
            <input
              type="number"
              inputMode="numeric"
              value={filters.depthMin}
              onChange={(event) => updateFilter("depthMin", event.target.value)}
            />
          </label>
          <span className="ftv-depth-separator">to</span>
          <label>
            <span>Depth</span>
            <input
              type="number"
              inputMode="numeric"
              value={filters.depthMax}
              onChange={(event) => updateFilter("depthMax", event.target.value)}
            />
          </label>
        </div>

        <div className="ftv-type-group">
          {groupedTypes.map(({ type, count }) => (
            <TypeToggle
              key={type}
              type={type}
              count={count}
              active={filters.types.has(type)}
              onToggle={handleTypeToggle}
            />
          ))}
        </div>

        <button type="button" className="ftv-reset" onClick={clearFilters}>
          Clear filters
        </button>
      </section>

      <div className="ftv-body">
        <div className="ftv-list" ref={containerRef} onScroll={handleScroll}>
          <div className="ftv-virtual-canvas" style={{ height: totalHeight }}>
            <div className="ftv-virtual-inner" style={{ transform: `translateY(${offset}px)` }}>
              {visibleItems.map((item) => (
                <TraceRow
                  key={item.__id}
                  item={item}
                  span={summary.span}
                  searchTerm={filters.search}
                  isSelected={item.__id === selectedId}
                  onSelect={handleSelect}
                />
              ))}
              {!visibleItems.length && (
                <div className="ftv-empty">
                  <p>No trace events match the current filters.</p>
                  <button type="button" onClick={clearFilters}>
                    Reset filters
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <DetailPanel item={selectedItem} />
      </div>
    </section>
  );
};

export default FunctionTracerViewer;

