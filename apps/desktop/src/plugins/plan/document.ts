import type { PlanProposal } from "@irudd-scope/protocol/plan";

// Each inspection receives its own proposal, including when displaying a retained basis.
export function planHtml(proposal: PlanProposal) {
  const data = JSON.stringify(proposal)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `<!doctype html><script>window.scopePlan={data:${data}};
  document.addEventListener('DOMContentLoaded',()=>{
    const data=window.scopePlan.data;
    const checks=data.checks||[];
    const fill=(selector,records,key)=>document.querySelectorAll(selector).forEach(node=>{
      const record=records.find(entry=>entry.id===node.getAttribute(selector.slice(1,-1)));
      if(record)node.textContent=record[key];
    });
    fill('[data-plan-goal]',data.goals||[],'outcome');
    fill('[data-plan-check]',checks,'expectation');
    const procedure=(node,check)=>{
      const details=document.createElement('details');
      const summary=document.createElement('summary'); summary.textContent='Test procedure'; details.append(summary);
      for(const [label,key] of [['Expected result','expectation'],['Conditions','conditions'],['Method','method'],['Judgment','kind']]){
        const heading=document.createElement('h4');heading.textContent=label;
        const text=document.createElement('p');text.textContent=check[key];text.style.whiteSpace='pre-wrap';
        details.append(heading,text);
      }
      node.replaceChildren(details);
    };
    document.querySelectorAll('[data-plan-procedure]').forEach(node=>{
      const check=checks.find(x=>x.id===node.dataset.planProcedure);if(check)procedure(node,check);
    });
    document.querySelectorAll('[data-plan-checks]').forEach(node=>{
      const visual=(data.visuals||[]).find(x=>x.id===node.dataset.planChecks);if(!visual)return;
      node.replaceChildren();
      for(const id of visual.checkIds){const check=checks.find(x=>x.id===id);if(!check)continue;
        const section=document.createElement('section');const heading=document.createElement('h3');heading.textContent=check.label;
        const body=document.createElement('div');procedure(body,check);section.append(heading,body);node.append(section);
      }
    });
  });</script>${proposal.overviewHtml}`;
}
