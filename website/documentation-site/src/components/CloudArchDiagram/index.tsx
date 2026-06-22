import React from 'react';

// ── palette ───────────────────────────────────────────────────────────────────
const C = {
  agent:  { stroke: '#389e0d', fill: '#f6ffed', dot: '#389e0d', text: '#135200' },
  dash:   { stroke: '#d46b08', fill: '#fff7e6', dot: '#d46b08', text: '#612500' },
  broker: { stroke: '#0369a1', fill: '#e0f2fe', header: '#01478a', div: '#7dd3fc', chip: '#bae6fd', text: '#01478a' },
  api:    { stroke: '#1677ff', fill: '#e6f4ff', header: '#0958d9', div: '#91caff', chip: '#bae0ff', text: '#003eb3' },
  redis:  { stroke: '#cf1322', fill: '#fff1f0', header: '#820014', div: '#ffa39e', chip: '#ffccc7', text: '#5c0011' },
  ingest: { stroke: '#531dab', fill: '#f9f0ff', header: '#22075e', div: '#d3adf7', chip: '#efdbff', text: '#22075e' },
  pg:     { stroke: '#006d75', fill: '#e6fffb', header: '#002329', div: '#87e8de', chip: '#b5f5ec', text: '#002329' },
  arrowG: '#bfbfbf',
  arrowB: '#1677ff',
  arrowQ: '#8c8c8c',
  label:  '#8c8c8c',
  sub:    '#8c8c8c',
  bg:     '#f8fafc',
  border: '#e2e8f0',
};

// ── layout constants ──────────────────────────────────────────────────────────
const W = 1040, H = 288;

const SX = 12, SW = 112, SH = 36;
const AY  = [68, 112, 156];
const DY  = 238;
const BUS = SX + SW + 10; // x=134

const MQX = 150, MQY = 38, MQW = 116, MQH = 146;
const MQCX = MQX + MQW / 2;

const APX = 286, APY = 38, APW = 150, APH = 230;
const APCX = APX + APW / 2;

const RX = 490, RY = 38, RW = 126, RH = 146;
const RCX = RX + RW / 2;

const IX = 662, IY = 38, IW = 144, IH = 146;
const ICX = IX + IW / 2;

const PX = 856, PY = 38, PW = 172, PH = 230;
const PCX = PX + PW / 2;

const WY = AY[1]; // write-path y (112) — aligns with agent 2, broker center, Redis center
const QY = 252;   // query-path y

// ── helpers ───────────────────────────────────────────────────────────────────
function Dot({ cx, cy, color }: { cx: number; cy: number; color: string }) {
  return <circle cx={cx} cy={cy} r={4.5} fill={color} />;
}

function ArrowMarker({ id, color }: { id: string; color: string }) {
  return (
    <marker id={id} markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill={color} />
    </marker>
  );
}

function SrcBox({ label, sub, cy, c }: {
  label: string; sub: string; cy: number;
  c: { stroke: string; fill: string; dot: string; text: string };
}) {
  return (
    <g filter="url(#cl-sh)">
      <rect x={SX} y={cy - SH / 2} width={SW} height={SH} rx={6}
        fill={c.fill} stroke={c.stroke} strokeWidth={1.5} />
      <Dot cx={SX + 13} cy={cy} color={c.dot} />
      <text x={SX + 24} y={cy - 6} fontSize={11} fill={c.text}
        fontWeight="700" dominantBaseline="auto">{label}</text>
      <text x={SX + 24} y={cy + 8} fontSize={9} fill={c.stroke}
        opacity={0.8} dominantBaseline="auto">{sub}</text>
    </g>
  );
}

function ColBox({ x, y, w, h, c }: {
  x: number; y: number; w: number; h: number;
  c: { stroke: string; fill: string; header: string; div: string };
}) {
  return (
    <rect x={x} y={y} width={w} height={h} rx={10}
      fill={c.fill} stroke={c.stroke} strokeWidth={2} filter="url(#cl-sh)" />
  );
}

function ColLabel({ cx, y, label, color }: {
  cx: number; y: number; label: string; color: string;
}) {
  return (
    <text x={cx} y={y} textAnchor="middle" fontSize={11}
      fill={color} fontWeight="700" dominantBaseline="middle">{label}</text>
  );
}

function Divider({ x, y, w, color }: { x: number; y: number; w: number; color: string }) {
  return <line x1={x + 10} y1={y} x2={x + w - 10} y2={y} stroke={color} strokeWidth={1} />;
}

function Chip({ x, y, w, h, label, c }: {
  x: number; y: number; w: number; h: number; label: string;
  c: { stroke: string; chip: string; dot?: string; text: string };
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={5}
        fill="white" stroke={c.chip} strokeWidth={1.2} />
      <Dot cx={x + 13} cy={y + h / 2} color={c.dot || c.stroke} />
      <text x={x + 24} y={y + h / 2} fontSize={10} fill={c.text}
        fontWeight="600" dominantBaseline="middle">{label}</text>
    </g>
  );
}

// ── component ─────────────────────────────────────────────────────────────────
export default function CloudArchDiagram() {
  const PAD = 10;

  const brokerChips = [
    { label: 'Mosquitto' },
    { label: 'File Auth'  },
  ];

  const apiChips = [
    { label: 'MQTT Subscriber' },
    { label: 'REST Endpoints'  },
    { label: 'Auth / JWT'      },
    { label: 'Redis Publisher' },
    { label: 'Query Layer'     },
  ];

  const redisChips = [
    { label: 'Ingest stream' },
    { label: 'Logs stream'   },
    { label: 'Pub/Sub'       },
  ];

  const ingChips = [
    { label: 'Consumer Workers' },
    { label: 'Normalizer'       },
    { label: 'Circuit Breaker'  },
    { label: 'Disk Spool'       },
  ];

  const pgChips = [
    { label: 'readings (hypertable)' },
    { label: 'Cont. Aggregates'      },
    { label: 'State & Config'        },
    { label: 'Audit Logs'            },
  ];

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
      aria-label="Cloud architecture: agents publish telemetry over MQTT to a Mosquitto broker; the Cloud API subscribes and routes data to Redis streams; the Ingestion worker persists readings to TimescaleDB"
    >
      <defs>
        <ArrowMarker id="cl-gray" color={C.arrowG} />
        <ArrowMarker id="cl-blue" color={C.arrowB} />
        <ArrowMarker id="cl-dash" color={C.arrowQ} />
        <filter id="cl-sh" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="1" stdDeviation="3" floodColor="#0000001a" />
        </filter>
      </defs>

      {/* background */}
      <rect width={W} height={H} rx={14} fill={C.bg} stroke={C.border} strokeWidth={1} />

      {/* column labels */}
      {([
        { x: SX + SW / 2, label: 'SOURCES'     },
        { x: MQCX,        label: 'BROKER'       },
        { x: APCX,        label: 'CLOUD API'   },
        { x: RCX,         label: 'REDIS'        },
        { x: ICX,         label: 'INGESTION'    },
        { x: PCX,         label: 'TIMESCALEDB'  },
      ] as const).map(({ x, label }) => (
        <text key={label} x={x} y={20} textAnchor="middle" fontSize={8.5}
          fill={C.label} fontWeight="700" letterSpacing={1.2}>{label}</text>
      ))}

      {/* ── source boxes ── */}
      <SrcBox label="Agent 1"   sub="IoT device"      cy={AY[0]} c={C.agent} />
      <SrcBox label="Agent 2"   sub="IoT device"      cy={AY[1]} c={C.agent} />
      <SrcBox label="Agent N"   sub="IoT device"      cy={AY[2]} c={C.agent} />
      <SrcBox label="Dashboard" sub="web / API client" cy={DY}   c={C.dash}  />

      {/* ── fan-in wiring: agents → bus → MQTT broker ── */}
      {AY.map((cy, i) => (
        <line key={i} x1={SX + SW} y1={cy} x2={BUS} y2={cy}
          stroke={C.arrowG} strokeWidth={1.5} />
      ))}
      <line x1={BUS} y1={AY[0]} x2={BUS} y2={AY[2]} stroke={C.arrowG} strokeWidth={1.5} />
      <line x1={BUS} y1={WY} x2={MQX - 1} y2={WY}
        stroke={C.arrowB} strokeWidth={2} markerEnd="url(#cl-blue)" />
      <text x={(BUS + MQX) / 2} y={WY - 5} textAnchor="middle"
        fontSize={8.5} fill={C.arrowB}>MQTT publish</text>

      {/* dashboard → API (bypasses broker) */}
      <line x1={SX + SW} y1={DY} x2={APX - 1} y2={DY}
        stroke={C.arrowG} strokeWidth={1.5} markerEnd="url(#cl-gray)" />

      {/* ── MQTT Broker box ── */}
      <ColBox x={MQX} y={MQY} w={MQW} h={MQH} c={C.broker} />
      <ColLabel cx={MQCX} y={MQY + 17} label="MQTT Broker" color={C.broker.header} />
      <Divider x={MQX} y={MQY + 28} w={MQW} color={C.broker.div} />
      {brokerChips.map(({ label }, i) => (
        <Chip key={label}
          x={MQX + PAD} y={MQY + 34 + i * 38}
          w={MQW - PAD * 2} h={30} label={label}
          c={{ stroke: C.broker.stroke, chip: C.broker.chip, dot: C.broker.stroke, text: C.broker.text }} />
      ))}

      {/* ── MQTT Broker → Cloud API ── */}
      <line x1={MQX + MQW} y1={WY} x2={APX - 1} y2={WY}
        stroke={C.arrowB} strokeWidth={2} markerEnd="url(#cl-blue)" />
      <text x={(MQX + MQW + APX) / 2} y={WY - 5} textAnchor="middle"
        fontSize={8.5} fill={C.arrowB}>subscribe</text>

      {/* ── Cloud API box ── */}
      <ColBox x={APX} y={APY} w={APW} h={APH} c={C.api} />
      <ColLabel cx={APCX} y={APY + 17} label="Cloud API" color={C.api.header} />
      <Divider x={APX} y={APY + 28} w={APW} color={C.api.div} />
      {apiChips.map(({ label }, i) => (
        <Chip key={label}
          x={APX + PAD} y={APY + 34 + i * 36}
          w={APW - PAD * 2} h={28} label={label}
          c={{ stroke: C.api.stroke, chip: C.api.chip, dot: C.api.stroke, text: C.api.text }} />
      ))}

      {/* ── Cloud API → Redis (write) ── */}
      <line x1={APX + APW} y1={WY} x2={RX - 1} y2={WY}
        stroke={C.arrowB} strokeWidth={2} markerEnd="url(#cl-blue)" />
      <text x={(APX + APW + RX) / 2} y={WY - 5} textAnchor="middle"
        fontSize={8.5} fill={C.arrowB}>write</text>

      {/* ── Redis box ── */}
      <ColBox x={RX} y={RY} w={RW} h={RH} c={C.redis} />
      <ColLabel cx={RCX} y={RY + 17} label="Redis Streams" color={C.redis.header} />
      <Divider x={RX} y={RY + 28} w={RW} color={C.redis.div} />
      {redisChips.map(({ label }, i) => (
        <Chip key={label}
          x={RX + PAD} y={RY + 34 + i * 34}
          w={RW - PAD * 2} h={26} label={label}
          c={{ stroke: C.redis.stroke, chip: C.redis.chip, dot: C.redis.stroke, text: C.redis.text }} />
      ))}

      {/* ── Redis → Ingestion ── */}
      <line x1={RX + RW} y1={WY} x2={IX - 1} y2={WY}
        stroke={C.arrowB} strokeWidth={2} markerEnd="url(#cl-blue)" />

      {/* ── Ingestion box ── */}
      <ColBox x={IX} y={IY} w={IW} h={IH} c={C.ingest} />
      <ColLabel cx={ICX} y={IY + 17} label="Ingestion" color={C.ingest.header} />
      <Divider x={IX} y={IY + 28} w={IW} color={C.ingest.div} />
      {ingChips.map(({ label }, i) => (
        <Chip key={label}
          x={IX + PAD} y={IY + 34 + i * 28}
          w={IW - PAD * 2} h={22} label={label}
          c={{ stroke: C.ingest.stroke, chip: C.ingest.chip, dot: C.ingest.stroke, text: C.ingest.text }} />
      ))}

      {/* ── Ingestion → TimescaleDB ── */}
      <line x1={IX + IW} y1={WY} x2={PX - 1} y2={WY}
        stroke={C.arrowB} strokeWidth={2} markerEnd="url(#cl-blue)" />

      {/* ── TimescaleDB box ── */}
      <ColBox x={PX} y={PY} w={PW} h={PH} c={C.pg} />
      <ColLabel cx={PCX} y={PY + 17} label="TimescaleDB" color={C.pg.header} />
      <Divider x={PX} y={PY + 28} w={PW} color={C.pg.div} />
      {pgChips.map(({ label }, i) => (
        <Chip key={label}
          x={PX + PAD} y={PY + 34 + i * 36}
          w={PW - PAD * 2} h={28} label={label}
          c={{ stroke: C.pg.stroke, chip: C.pg.chip, dot: C.pg.stroke, text: C.pg.text }} />
      ))}

      {/* ── Cloud API → TimescaleDB (query path, dashed) ── */}
      <line x1={APX + APW} y1={QY} x2={PX - 1} y2={QY}
        stroke={C.arrowQ} strokeWidth={1.5} strokeDasharray="5 4"
        markerEnd="url(#cl-dash)" />
      <text x={(APX + APW + PX) / 2} y={QY - 5} textAnchor="middle"
        fontSize={8.5} fill={C.arrowQ}>query path</text>
    </svg>
  );
}
