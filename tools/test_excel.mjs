import dotenv from 'dotenv';
dotenv.config();

import { openDatabase } from '../config/database.js';
import { getOrders } from '../services/adminService.js';
import * as XLSX from 'xlsx';

function parseDate(value) {
  if (!value) return null;
  if (typeof value?.toDate === 'function') return value.toDate();
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  let s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
    s = s.replace(' ', 'T');
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function toIndiaDate(date) {
  const tzStr = date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  return new Date(tzStr);
}
function formatStr(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(date.getDate()).padStart(2, '0')}-${months[date.getMonth()]}-${date.getFullYear()}`;
}

async function test() {
  const db = openDatabase();
  const orders = await getOrders(db, { includeCompleted: true });

  const groups = {};
  let overallCancel = 0, overallDiscount = 0, overallService = 0;

  orders.forEach(order => {
    let d = parseDate(order.createdAt);
    if (!d) return;
    const bizDate = toIndiaDate(d);
    if (bizDate.getHours() < 7) {
      bizDate.setDate(bizDate.getDate() - 1);
    }
    const dateStr = formatStr(bizDate);
    if (!groups[dateStr]) {
      groups[dateStr] = {
        dateStr, bizDate,
        foodMin: 99999999, foodMax: 0,
        liquorMin: 99999999, liquorMax: 0,
        food: 0, liquor: 0,
        cash: 0, card: 0, online: 0,
        tip: 0, grTotal: 0
      };
    }
    const g = groups[dateStr];
    let fTotal = 0, lTotal = 0;
    order.items?.forEach(item => {
      const cat = item.category?.English || item.category || '';
      const isLiquor = /beer|wine|liquor|liqueur|cocktail|spirits|alcohol|whisky|whiskey|vodka|rum|gin|tequila|brandy/i.test(cat);
      const lineTotal = (Number(item.price) || 0) * (Number(item.quantity) || 0);
      if (isLiquor) lTotal += lineTotal;
      else fTotal += lineTotal;
    });
    const disc = Number(order.discountAmount) || 0;
    overallDiscount += disc;
    if (order.status === 'Cancelled') overallCancel += (Number(order.total) || 0);
    const fRatio = (fTotal + lTotal) > 0 ? (fTotal / (fTotal + lTotal)) : 0;
    const lRatio = (fTotal + lTotal) > 0 ? (lTotal / (fTotal + lTotal)) : 0;
    const fNet = Math.round(fTotal - (disc * fRatio));
    const lNet = Math.round(lTotal - (disc * lRatio));
    if (order.status !== 'Cancelled') {
      g.food += fNet;
      g.liquor += lNet;
      const finalTot = Number(order.finalTotal ?? order.total) || 0;
      g.grTotal += finalTot;
      const splits = order.paymentSplits ? (typeof order.paymentSplits === 'string' ? JSON.parse(order.paymentSplits) : order.paymentSplits) : null;
      if (splits && (splits.cash || splits.Cash || splits.card || splits.Card || splits.upi || splits.UPI || splits.zomato || splits.Zomato)) {
        g.cash += Number(splits.cash ?? splits.Cash ?? 0) || 0;
        g.card += Number(splits.card ?? splits.Card ?? 0) || 0;
        g.online += (Number(splits.upi ?? splits.UPI ?? 0) || 0) + (Number(splits.zomato ?? splits.Zomato ?? 0) || 0);
      } else {
        const pm = (order.paymentMethod || '').toUpperCase();
        if (pm.includes('CASH') && !pm.includes('UPI') && !pm.includes('CARD')) g.cash += finalTot;
        else if (pm.includes('CARD') && !pm.includes('CASH') && !pm.includes('UPI')) g.card += finalTot;
        else g.online += finalTot;
      }
      const tip = Number(order.tipAmount || order.tip || 0);
      if (tip > 0) g.tip = (g.tip || 0) + tip;
    }
  });

  const sortedDates = Object.values(groups).sort((a, b) => a.bizDate.getTime() - b.bizDate.getTime());
  console.log('Number of dates in sortedDates:', sortedDates.length);
  sortedDates.forEach(d => console.log('Date:', d.dateStr, 'Total:', d.grTotal));

  const aoa = [
    ["RUSTIC CHARM"],
    ["BILL WISE SALE REPORT"],
    [`REPORT DATE: ${sortedDates[0]?.dateStr} TO ${sortedDates[sortedDates.length-1]?.dateStr}`],
    [`PRINT DATE: test`],
    [],
    [],
    ["DATE", "FOOD", "TOTAL", "LIQUOR", "TOTAL", "GR.TOTAL", "CASH", "CARD", "ONLINE", null, null, null, null, "TIP"]
  ];

  let sumFood = 0, sumLiquor = 0, sumGrTotal = 0, sumCash = 0, sumCard = 0, sumOnline = 0;

  sortedDates.forEach((g) => {
    sumFood += g.food;
    sumLiquor += g.liquor;
    sumGrTotal += g.grTotal;
    sumCash += g.cash;
    sumCard += g.card;
    sumOnline += g.online;

    aoa.push([
      g.dateStr,
      g.food,
      g.food,
      g.liquor,
      g.liquor,
      g.grTotal,
      g.cash,
      g.card,
      g.online,
      null,
      null,
      null,
      null,
      g.tip || 0
    ]);
  });

  const bottomTotalRowIndex = aoa.length + 1;
  aoa.push([
    null,
    sumFood, sumFood,
    sumLiquor, sumLiquor,
    sumGrTotal, sumCash, sumCard, sumOnline,
    null,
    null,
    null,
    null,
    null
  ]);

  const grossAmount = sumGrTotal + overallCancel + overallDiscount - overallService;

  while (aoa.length <= 11) aoa.push(new Array(14).fill(null));

  aoa[6][9] = null;
  aoa[6][10] = "GROSS AMOUNT:";
  aoa[6][11] = grossAmount;

  aoa[7][9] = null;
  aoa[7][10] = "BILL CANCEL AMOUNT:(-)";
  aoa[7][11] = overallCancel;

  aoa[8][9] = null;
  aoa[8][10] = "DISCOUNT:(-)";
  aoa[8][11] = overallDiscount;

  aoa[9][9] = null;
  aoa[9][10] = "Service Chrg@0.00%:(+)";
  aoa[9][11] = overallService;

  aoa[10][9] = null;
  aoa[10][10] = "NET AMOUNT:";
  aoa[10][11] = sumGrTotal;

  console.log('\n--- Full AOA Rows ---');
  aoa.forEach((row, i) => {
    console.log(`Row ${i + 1}:`, JSON.stringify(row));
  });

  process.exit(0);
}
test();
