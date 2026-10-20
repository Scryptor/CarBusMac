export interface TabDef {
  id: string;
  label: string;
}

export function Tabs({ tabs, active, onChange }: { tabs: TabDef[]; active: string; onChange: (id: string) => void }) {
  return (
    <div class="tabs" role="tablist">
      {tabs.map((tb) => (
        <button
          type="button"
          role="tab"
          class="tab"
          aria-selected={tb.id === active}
          onClick={() => onChange(tb.id)}
        >
          {tb.label}
        </button>
      ))}
    </div>
  );
}
