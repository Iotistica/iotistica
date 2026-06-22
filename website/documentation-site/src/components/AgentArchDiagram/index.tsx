import React from 'react';

// ── palette ──────────────────────────────────────────────────────────────────

const C = {
  modbus:     { stroke: '#389e0d', fill: '#f6ffed', dot: '#389e0d', text: '#135200' },
  opcua:      { stroke: '#531dab', fill: '#f9f0ff', dot: '#531dab', text: '#22075e' },
  bacnet:     { stroke: '#d46b08', fill: '#fff7e6', dot: '#d46b08', text: '#612500' },
  mqtt:       { stroke: '#006d75', fill: '#e6fffb', dot: '#006d75', text: '#002329' },
  influx:     { stroke: '#be0027', fill: '#fff1f0', dot: '#be0027', text: '#5c0011' },
  azure:      { stroke: '#0078d4', fill: '#e6f4ff', dot: '#0078d4', text: '#003a8c' },
  aws:        { stroke: '#b36200', fill: '#fffbe6', dot: '#b36200', text: '#613400' },
  iotistica:  { stroke: '#1677ff', fill: '#e6f4ff', dot: '#1677ff', text: '#003eb3' },
  ep:         { stroke: '#1677ff', fill: '#e6f4ff', header: '#0958d9', div: '#91caff', chip: '#bae0ff' },
  pp:         { stroke: '#531dab', fill: '#f5f0ff', header: '#391085', div: '#d3adf7', chip: '#d3adf7' },
  arrow:      '#bfbfbf',
  arrowEp:    '#1677ff',
  label:      '#8c8c8c',
  subtext:    '#8c8c8c',
  bg:         '#f8fafc',
  border:     '#e2e8f0',
};

// ── layout constants ──────────────────────────────────────────────────────────

const W = 980;
const H = 410;

const SRC_X = 18;
const SRC_W = 148;
const SRC_H = 50;
const SRC_Y = [80, 150, 220, 290]; // 4 sources, spacing=70

const BUS_IN = SRC_X + SRC_W + 22; // x=188

const EP_X  = 214;
const EP_Y  = 40;
const EP_W  = 154;
const EP_H  = 298; // covers sources 80–290 with padding

const PP_X  = 418;
const PP_Y  = 40;
const PP_W  = 178;
const PP_H  = 298;

const BUS_OUT = PP_X + PP_W + 22; // x=618

const DST_X = 648;
const DST_W = 312;
const DST_H = 50;
const DST_Y = [80, 146, 212, 278, 344]; // 5 destinations, spacing=66

const EP_CX = EP_X + EP_W / 2;
const EP_CY = EP_Y + EP_H / 2; // = 189
const PP_CX = PP_X + PP_W / 2;
const PP_CY = PP_Y + PP_H / 2; // = 189

// ── data ─────────────────────────────────────────────────────────────────────

const SOURCES = [
  { label: 'Modbus',  sub: 'TCP · RTU',   c: C.modbus },
  { label: 'OPC-UA',  sub: 'opc.tcp://',  c: C.opcua  },
  { label: 'BACnet',  sub: 'IP · MSTP',   c: C.bacnet },
  { label: 'MQTT',    sub: 'subscriber',  c: C.mqtt   },
];

const DESTINATIONS = [
  { label: 'Iotistica API', sub: 'cloud platform',  c: C.iotistica },
  { label: 'MQTT Broker',   sub: 'local or cloud',  c: C.mqtt      },
  { label: 'InfluxDB',      sub: 'time-series DB',  c: C.influx    },
  { label: 'Azure IoT Hub', sub: 'cloud',           c: C.azure     },
  { label: 'AWS IoT Core',  sub: 'cloud',           c: C.aws       },
];

const PP_ITEMS = [
  { label: 'Anomaly Detection' },
  { label: 'Schema Drift'      },
  { label: 'Subscriptions'     },
  { label: 'Offline Buffer'    },
];

// ── helpers ───────────────────────────────────────────────────────────────────

function Dot({ cx, cy, color }: { cx: number; cy: number; color: string }) {
  return <circle cx={cx} cy={cy} r={5.5} fill={color} />;
}

function ArrowMarker({ id, color }: { id: string; color: string }) {
  return (
    <marker id={id} markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill={color} />
    </marker>
  );
}

// ── component ─────────────────────────────────────────────────────────────────

export default function AgentArchDiagram() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${W} ${H}`}
      style={{
        width: '100%',
        maxWidth: `${W}px`,
        display: 'block',
        margin: '28px auto 4px',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
      aria-label="Agent architecture diagram: protocol sources flow into endpoints, through the publish pipeline, and out to destinations"
    >
      <defs>
        <ArrowMarker id="a-gray" color={C.arrow}   />
        <ArrowMarker id="a-blue" color={C.arrowEp} />
        <filter id="arch-sh" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="1" stdDeviation="3" floodColor="#0000001a" />
        </filter>
      </defs>

      {/* ── background ── */}
      <rect width={W} height={H} rx={14} fill={C.bg} stroke={C.border} strokeWidth={1} />

      {/* ── column labels ── */}
      {[
        { x: SRC_X + SRC_W / 2, label: 'SOURCES'      },
        { x: EP_CX,              label: 'ENDPOINTS'    },
        { x: PP_CX,              label: 'PUBLISH'      },
        { x: DST_X + DST_W / 2, label: 'DESTINATIONS' },
      ].map(({ x, label }) => (
        <text key={label} x={x} y={22} textAnchor="middle" fontSize={9.5}
          fill={C.label} fontWeight="700" letterSpacing={1.4}>{label}</text>
      ))}

      {/* ── fan-in: sources → bus → endpoints ── */}
      {SRC_Y.map((cy, i) => (
        <line key={i} x1={SRC_X + SRC_W} y1={cy} x2={BUS_IN} y2={cy}
          stroke={C.arrow} strokeWidth={1.5} />
      ))}
      <line x1={BUS_IN} y1={SRC_Y[0]} x2={BUS_IN} y2={SRC_Y[3]}
        stroke={C.arrow} strokeWidth={1.5} />
      <line x1={BUS_IN} y1={EP_CY} x2={EP_X - 1} y2={EP_CY}
        stroke={C.arrow} strokeWidth={1.5} markerEnd="url(#a-gray)" />

      {/* ── source boxes ── */}
      {SOURCES.map(({ label, sub, c }, i) => {
        const by = SRC_Y[i] - SRC_H / 2;
        const cy = SRC_Y[i];
        return (
          <g key={label} filter="url(#arch-sh)">
            <rect x={SRC_X} y={by} width={SRC_W} height={SRC_H} rx={8}
              fill={c.fill} stroke={c.stroke} strokeWidth={1.5} />
            <Dot cx={SRC_X + 18} cy={cy} color={c.dot} />
            <text x={SRC_X + 34} y={cy - 7} fontSize={13} fill={c.text}
              fontWeight="700" dominantBaseline="auto">{label}</text>
            <text x={SRC_X + 34} y={cy + 10} fontSize={10.5} fill={c.stroke}
              opacity={0.8} dominantBaseline="auto">{sub}</text>
          </g>
        );
      })}

      {/* ── endpoints box ── */}
      <rect x={EP_X} y={EP_Y} width={EP_W} height={EP_H} rx={10}
        fill={C.ep.fill} stroke={C.ep.stroke} strokeWidth={2} filter="url(#arch-sh)" />
      <text x={EP_CX} y={EP_Y + 19} textAnchor="middle" fontSize={13}
        fill={C.ep.header} fontWeight="700" dominantBaseline="middle">Endpoints</text>
      <line x1={EP_X + 12} y1={EP_Y + 32} x2={EP_X + EP_W - 12} y2={EP_Y + 32}
        stroke={C.ep.div} strokeWidth={1} />

      {/* Protocol adapter chips */}
      {SOURCES.map(({ label, c }, i) => {
        const iy = EP_Y + 40 + i * 62;
        return (
          <g key={label}>
            <rect x={EP_X + 8} y={iy} width={EP_W - 16} height={44} rx={7}
              fill="white" stroke={C.ep.chip} strokeWidth={1.2} />
            <Dot cx={EP_X + 22} cy={iy + 22} color={c.dot} />
            <text x={EP_X + 36} y={iy + 14} fontSize={12} fill={c.text}
              fontWeight="700" dominantBaseline="auto">{label}</text>
            <text x={EP_X + 36} y={iy + 30} fontSize={10} fill={C.subtext}
              dominantBaseline="auto">adapter</text>
          </g>
        );
      })}

      {/* ── endpoints → publish arrow ── */}
      <line x1={EP_X + EP_W} y1={EP_CY} x2={PP_X - 1} y2={PP_CY}
        stroke={C.arrowEp} strokeWidth={2} markerEnd="url(#a-blue)" />

      {/* ── publish box ── */}
      <rect x={PP_X} y={PP_Y} width={PP_W} height={PP_H} rx={10}
        fill={C.pp.fill} stroke={C.pp.stroke} strokeWidth={2} filter="url(#arch-sh)" />
      <text x={PP_CX} y={PP_Y + 19} textAnchor="middle" fontSize={13}
        fill={C.pp.header} fontWeight="700" dominantBaseline="middle">Publish</text>
      <line x1={PP_X + 12} y1={PP_Y + 32} x2={PP_X + PP_W - 12} y2={PP_Y + 32}
        stroke={C.pp.div} strokeWidth={1} />

      {/* Publish sub-items */}
      {PP_ITEMS.map(({ label }, i) => {
        const iy = PP_Y + 40 + i * 62;
        return (
          <g key={label}>
            <rect x={PP_X + 8} y={iy} width={PP_W - 16} height={44} rx={7}
              fill="white" stroke={C.pp.chip} strokeWidth={1.2} />
            <Dot cx={PP_X + 22} cy={iy + 22} color={C.pp.stroke} />
            <text x={PP_X + 36} y={iy + 22} fontSize={12} fill={C.pp.header}
              fontWeight="700" dominantBaseline="middle">{label}</text>
          </g>
        );
      })}

      {/* ── fan-out: publish → bus → destinations ── */}
      <line x1={PP_X + PP_W} y1={PP_CY} x2={BUS_OUT} y2={PP_CY}
        stroke={C.arrow} strokeWidth={1.5} />
      <line x1={BUS_OUT} y1={DST_Y[0]} x2={BUS_OUT} y2={DST_Y[4]}
        stroke={C.arrow} strokeWidth={1.5} />
      {DST_Y.map((cy, i) => (
        <line key={i} x1={BUS_OUT} y1={cy} x2={DST_X - 1} y2={cy}
          stroke={C.arrow} strokeWidth={1.5} markerEnd="url(#a-gray)" />
      ))}

      {/* ── destination boxes ── */}
      {DESTINATIONS.map(({ label, sub, c }, i) => {
        const by = DST_Y[i] - DST_H / 2;
        const cy = DST_Y[i];
        return (
          <g key={label} filter="url(#arch-sh)">
            <rect x={DST_X} y={by} width={DST_W} height={DST_H} rx={8}
              fill={c.fill} stroke={c.stroke} strokeWidth={1.5} />
            <Dot cx={DST_X + 18} cy={cy} color={c.dot} />
            <text x={DST_X + 34} y={cy - 7} fontSize={13} fill={c.text}
              fontWeight="700" dominantBaseline="auto">{label}</text>
            <text x={DST_X + 34} y={cy + 10} fontSize={10.5} fill={c.stroke}
              opacity={0.8} dominantBaseline="auto">{sub}</text>
          </g>
        );
      })}
    </svg>
  );
}
