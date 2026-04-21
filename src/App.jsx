import { useState, useEffect, useCallback } from "react";

const PRIORITY = {
  linedown:{ label:"Line Down", bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" },
  asap:    { label:"ASAP",      bg:"#FAEEDA", text:"#854F0B", dot:"#EF9F27" },
  asready: { label:"As Ready",  bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" },
};
const STATUS_MAP = {
  pending:   { label:"Pending Review", bg:"#FAEEDA", text:"#854F0B", dot:"#EF9F27" },
  approved:  { label:"Approved",       bg:"#E6F1FB", text:"#185FA5", dot:"#378ADD" },
  done:      { label:"Staged / Done",  bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" },
  cancelled: { label:"Cancelled",      bg:"#F1EFE8", text:"#5F5E5A", dot:"#888780" },
};

function hoursOld(ts) { return (Date.now() - new Date(ts)) / 36e5; }
function isOverdue(dn) { return new Date(dn + "T23:59:59") < new Date(); }
function isAgeAlert(r) { return r.status === "pending" && hoursOld(r.timestamp) > 24; }

function timeAgo(ts) {
  const d = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d/60)}m ago`;
  if (d < 86400) return `${Math.floor(d/3600)}h ago`;
  return `${Math.floor(d/86400)}d ago`;
}

function Avatar({ name="?", size=34 }) {
  const ini = name.split(/[\s._]+/).map(w=>w[0]).join("").slice(0,2).toUpperCase();
  const bgs = ["#CECBF6","#9FE1CB","#F5C4B3","#B5D4F4","#C0DD97","#FAC775"];
  const txts= ["#3C3489","#085041","#993C1D","#0C447C","#27500A","#854F0B"];
  const i = (name.charCodeAt(0)||0) % bgs.length;
  return <div style={{width:size,height:size,borderRadius:"50%",background:bgs[i],color:txts[i],display:"flex",alignItems:"center",justifyContent:"center",fontSize:size*0.35,fontWeight:500,flexShrink:0}}>{ini}</div>;
}

function PriBadge({ p }) {
  const c = PRIORITY[p]||PRIORITY.asready;
  return <span style={{background:c.bg,color:c.text,borderRadius:20,padding:"2px 9px",fontSize:11,fontWeight:500,display:"inline-flex",alignItems:"center",gap:5}}><span style={{width:6,height:6,borderRadius:"50%",background:c.dot,flexShrink:0}}/>{c.label}</span>;
}

function StatusBadge({ status, onChange }) {
  const [open,setOpen] = useState(false);
  const c = STATUS_MAP[status]||STATUS_MAP.pending;
  return (
    <div style={{position:"relative",display:"inline-block"}}>
      <button onClick={()=>setOpen(o=>!o)} style={{background:c.bg,color:c.text,border:"none",borderRadius:20,padding:"4px 11px",fontSize:12,fontWeight:500,cursor:"pointer",display:"flex",alignItems:"center",gap:5}}>
        <span style={{width:7,height:7,borderRadius:"50%",background:c.dot,flexShrink:0}}/>{c.label}<span style={{fontSize:9,opacity:0.6}}>▾</span>
      </button>
      {open && (
        <div style={{position:"absolute",top:"110%",left:0,background:"#fff",border:"0.5px solid #ddd",borderRadius:10,zIndex:20,minWidth:155,boxShadow:"0 4px 16px rgba(0,0,0,0.10)"}}>
          {Object.entries(STATUS_MAP).map(([k,v])=>(
            <div key={k} onClick={()=>{onChange(k);setOpen(false);}} style={{padding:"8px 13px",fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",gap:8,color:v.text}}
              onMouseEnter={e=>e.currentTarget.style.background="#f5f5f4"}
              onMouseLeave={e=>e.currentTarget.style.background=""}>
              <span style={{width:7,height:7,borderRadius:"50%",background:v.dot,flexShrink:0}}/>{v.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JournalIdChip({ id, url }) {
  const href = url || `https://joby-aviation-main.cloud.databricks.com/dashboardsv3/01f0bb4345f41e22836f1bd7593acb79/published?o=1086519755754860&f_e9afd8fa~journal-id=${id}&f_958df5fc~journal-id=${id}&f_5e39a936~97580db1=${id}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${id} in Databricks`}
      style={{
        fontSize:11,
        color:"#185FA5",
        background:"#E6F1FB",
        padding:"2px 8px",
        borderRadius:5,
        fontFamily:"monospace",
        textDecoration:"none",
        border:"0.5px solid #B5D4F4",
        display:"inline-flex",
        alignItems:"center",
        gap:4,
        cursor:"pointer",
      }}
      onMouseEnter={e=>e.currentTarget.style.background="#cfe3f8"}
      onMouseLeave={e=>e.currentTarget.style.background="#E6F1FB"}
    >
      {id}
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#185FA5" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}>
        <path d="M12 2L2 7l10 5 10-5-10-5z"/>
        <path d="M2 17l10 5 10-5"/>
        <path d="M2 12l10 5 10-5"/>
      </svg>
    </a>
  );
}

export default function App() {
  const [rows,setRows]           = useState([]);
  const [loading,setLoading]     = useState(true);
  const [error,setError]         = useState(null);
  const [lastSync,setLastSync]   = useState(null);
  const [countdown,setCountdown] = useState(300);
  const [filter,setFilter]       = useState("pending");
  const [search,setSearch]       = useState("");
  const [syncing,setSyncing]     = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setSyncing(true);
      const res  = await fetch('/api/requests?' + Date.now());
      const json = await res.json();
      if (json.requests) {
        setRows(json.requests);
        setLastSync(new Date());
        setCountdown(300);
        setError(null);
      }
    } catch (e) {
      setError('Failed to fetch data from Slack');
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    const t = setInterval(fetchData, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [fetchData]);
  useEffect(() => {
    const t = setInterval(() => setCountdown(c => c <= 1 ? 300 : c - 1), 1000);
    return () => clearInterval(t);
  }, []);

  function updateStatus(id,s){ setRows(rs=>rs.map(r=>r.id===id?{...r,status:s}:r)); }

  const counts = {
    all:       rows.length,
    pending:   rows.filter(r=>r.status==="pending").length,
    approved:  rows.filter(r=>r.status==="approved").length,
    done:      rows.filter(r=>r.status==="done").length,
    cancelled: rows.filter(r=>r.status==="cancelled").length,
    aged:      rows.filter(r=>isAgeAlert(r)).length,
    overdue:   rows.filter(r=>isOverdue(r.dateNeeded)&&!["done","cancelled"].includes(r.status)).length,
  };

  const filtered = rows.filter(r=>{
    if (filter!=="all"&&r.status!==filter) return false;
    const q=search.toLowerCase();
    if (q&&!r.id.toLowerCase().includes(q)&&!r.requester.toLowerCase().includes(q)&&!r.location?.toLowerCase().includes(q)) return false;
    return true;
  });

  const sorted = [...filtered].sort((a,b)=>{
    if (a.priority==="linedown"&&b.priority!=="linedown") return -1;
    if (b.priority==="linedown"&&a.priority!=="linedown") return 1;
    if (isAgeAlert(a)&&!isAgeAlert(b)) return -1;
    if (isAgeAlert(b)&&!isAgeAlert(a)) return 1;
    return new Date(b.timestamp)-new Date(a.timestamp);
  });

  const metrics = [
    { label:"Pending review", value:counts.pending,  color:"#EF9F27" },
    { label:"Approved",       value:counts.approved, color:"#378ADD" },
    { label:"Staged / Done",  value:counts.done,     color:"#639922" },
    { label:"Total",          value:counts.all,      color:"#888780" },
  ];

  const mins = Math.floor(countdown/60);
  const secs = String(countdown%60).padStart(2,"0");

  return (
    <div style={{minHeight:"100vh",background:"#f5f5f4",fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"}}>

      {/* Nav */}
      <div style={{background:"#fff",borderBottom:"0.5px solid #e5e5e3",padding:"0 20px",display:"flex",alignItems:"center",justifyContent:"space-between",height:52}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:28,height:28,borderRadius:8,background:"#E6F1FB",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#185FA5" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </div>
          <span style={{fontSize:14,fontWeight:500,color:"#1a1a1a"}}>Marina Part Request Dashboard</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <span style={{fontSize:12,color:"#aaa"}}>Next refresh {mins}:{secs}</span>
          <div style={{display:"flex",alignItems:"center",gap:5}}>
            <div style={{width:7,height:7,borderRadius:"50%",background:"#639922"}}/>
            <span style={{fontSize:12,color:"#666"}}>Live · @marina-mpms</span>
          </div>
        </div>
      </div>

      <div style={{maxWidth:860,margin:"0 auto",padding:"20px 16px"}}>

        {counts.aged>0&&<div style={{background:"#FAEEDA",border:"0.5px solid #EF9F27",borderRadius:10,padding:"10px 14px",marginBottom:10,display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:13,color:"#854F0B",fontWeight:500}}>⏰ {counts.aged} request{counts.aged>1?"s":""} pending over 24h — needs attention</span></div>}
        {counts.overdue>0&&<div style={{background:"#FCEBEB",border:"0.5px solid #E24B4A",borderRadius:10,padding:"10px 14px",marginBottom:10,display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:13,color:"#A32D2D",fontWeight:500}}>⚠ {counts.overdue} request{counts.overdue>1?"s":""} past Date Needed — action required</span></div>}

        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:10}}>
          <div>
            <h1 style={{fontSize:16,fontWeight:500,color:"#1a1a1a",margin:"0 0 2px"}}>Kit requests · @marina-mpms tagged</h1>
            <p style={{fontSize:11,color:"#aaa",margin:0}}>
              {lastSync ? `Last synced: ${lastSync.toLocaleTimeString()}` : "Loading..."} · {rows.length} requests · #part-requests-marina
            </p>
          </div>
          <div style={{display:"flex",gap:8}}>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search ID, name or location…"
              style={{padding:"6px 12px",borderRadius:8,border:"0.5px solid #ddd",fontSize:12,width:210,background:"#fff",color:"#1a1a1a",outline:"none"}}/>
            <button onClick={()=>fetchData()}
              style={{padding:"6px 14px",borderRadius:8,border:"0.5px solid #ddd",background:"#fff",fontSize:12,cursor:"pointer",color:"#555",display:"flex",alignItems:"center",gap:5}}>
              {syncing?"…":"⟳"} {syncing?"Syncing…":"Refresh"}
            </button>
          </div>
        </div>

        {error&&<div style={{background:"#FCEBEB",border:"0.5px solid #E24B4A",borderRadius:8,padding:"10px 14px",marginBottom:12,fontSize:13,color:"#A32D2D"}}>⚠ {error}</div>}
        {loading&&<div style={{textAlign:"center",padding:"3rem",color:"#aaa",fontSize:14}}>Loading from Slack...</div>}

        {!loading&&<div style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:8,marginBottom:14}}>
          {metrics.map(m=>(
            <div key={m.label} style={{background:"#fff",borderRadius:8,padding:"10px 14px",border:"0.5px solid #e5e5e3"}}>
              <p style={{fontSize:11,color:"#999",margin:"0 0 4px"}}>{m.label}</p>
              <p style={{fontSize:26,fontWeight:500,margin:0,color:m.color}}>{m.value}</p>
            </div>
          ))}
        </div>}

        {!loading&&<div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
          {["pending","approved","done","cancelled","all"].map(f=>(
            <button key={f} onClick={()=>setFilter(f)}
              style={{fontSize:12,padding:"5px 13px",borderRadius:20,cursor:"pointer",
                border:`0.5px solid ${filter===f?"#888":"#ddd"}`,
                background:filter===f?"#fff":"transparent",
                fontWeight:filter===f?500:400,color:"#1a1a1a",display:"flex",alignItems:"center",gap:5}}>
              {f==="all"?"All":STATUS_MAP[f]?.label}
              <span style={{fontSize:11,color:"#bbb",fontWeight:400}}>{counts[f]}</span>
            </button>
          ))}
        </div>}

        {!loading&&<div style={{display:"flex",flexDirection:"column",gap:8}}>
          {sorted.length===0&&<div style={{textAlign:"center",padding:"3rem",color:"#bbb",fontSize:14}}>No requests match</div>}
          {sorted.map(req=>{
            const aged=isAgeAlert(req);
            const overdue=isOverdue(req.dateNeeded)&&!["done","cancelled"].includes(req.status);
            const linedown=req.priority==="linedown";
            let border="0.5px solid #e5e5e3";
            if(linedown) border="1.5px solid #F09595";
            else if(aged) border="1.5px solid #EF9F27";
            return(
              <div key={req.id} style={{background:"#fff",border,borderRadius:12,padding:"13px 15px"}}>
                {aged&&<div style={{display:"flex",alignItems:"center",gap:6,background:"#FAEEDA",borderRadius:7,padding:"4px 10px",marginBottom:9,fontSize:12,color:"#854F0B",fontWeight:500}}>⏰ No response in {Math.floor(hoursOld(req.timestamp))}h — needs follow-up</div>}
                <div style={{display:"flex",gap:11,alignItems:"flex-start"}}>
                  <Avatar name={req.requester}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap",marginBottom:5}}>
                      <span style={{fontWeight:500,fontSize:13,color:"#1a1a1a"}}>{req.requester}</span>
                      <JournalIdChip id={req.id} url={req.d365Url} />
                      <PriBadge p={req.priority}/>
                      <span style={{fontSize:11,color:"#bbb",marginLeft:"auto"}}>{timeAgo(req.timestamp)}</span>
                    </div>
                    <div style={{display:"flex",gap:14,marginBottom:6,flexWrap:"wrap",alignItems:"center"}}>
                      <span style={{fontSize:12,color:"#999"}}>Warehouse: <span style={{color:"#1a1a1a",fontWeight:500}}>{req.warehouse}</span></span>
                      <span style={{fontSize:12,color:"#999"}}>Location: <span style={{color:"#185FA5",fontWeight:500}}>{req.location}</span></span>
                      <span style={{fontSize:12,color:"#999",display:"flex",alignItems:"center",gap:4}}>Needed:
                        <span style={{marginLeft:4,fontWeight:500,color:overdue?"#A32D2D":"#1a1a1a",background:overdue?"#FCEBEB":"transparent",padding:overdue?"1px 6px":"0",borderRadius:overdue?5:0,display:"inline-flex",alignItems:"center",gap:4}}>
                          {overdue&&"⚠ "}{req.dateNeeded}{overdue&&<span style={{fontSize:10}}> overdue</span>}
                        </span>
                      </span>
                      <span style={{fontSize:12,color:"#bbb"}}>{req.replyCount} repl{req.replyCount===1?"y":"ies"}</span>
                    </div>
                    {req.threadActivity&&<div style={{background:"#f8f8f7",borderRadius:7,padding:"5px 10px",marginBottom:9,fontSize:12,color:"#666",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>💬 {req.threadActivity}</div>}
                    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                      <StatusBadge status={req.status} onChange={s=>updateStatus(req.id,s)}/>
                      <a href={req.threadUrl} target="_blank" rel="noopener noreferrer"
                        style={{fontSize:12,color:"#185FA5",textDecoration:"none",display:"inline-flex",alignItems:"center",gap:4,padding:"4px 11px",borderRadius:20,border:"0.5px solid #B5D4F4",background:"#E6F1FB"}}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                        View thread
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>}

        <p style={{textAlign:"center",fontSize:11,color:"#ccc",marginTop:24}}>
          Marina Part Request Dashboard · {new Date().toLocaleDateString()}
        </p>
      </div>
    </div>
  );
}
