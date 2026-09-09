import dotenv from 'dotenv';
dotenv.config();

import { openDatabase } from '../config/database.js';
import { getOrders } from '../services/adminService.js';

function parseOrderDate(value) {
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

function getOrderBizDate(order) {
  const d = parseOrderDate(order.createdAt);
  if (!d) return null;
  const bizDate = toIndiaDate(d);
  if (bizDate.getHours() < 7) {
    bizDate.setDate(bizDate.getDate() - 1);
  }
  return bizDate;
}

function getTodayBizDate() {
  const bizDate = toIndiaDate(new Date());
  if (bizDate.getHours() < 7) {
    bizDate.setDate(bizDate.getDate() - 1);
  }
  return bizDate;
}

function isEligibleForReport(order) {
  if (!order) return false;
  const status = String(order.status || '').toLowerCase();
  if (status === 'rejected') return false;
  return true;
}

function getDailyOrders(orders) {
  const todayBiz = getTodayBizDate();
  const y = todayBiz.getFullYear(), m = todayBiz.getMonth(), d = todayBiz.getDate();
  return orders.filter(o => {
    if (!isEligibleForReport(o)) return false;
    const b = getOrderBizDate(o);
    return b && b.getFullYear() === y && b.getMonth() === m && b.getDate() === d;
  });
}

function get15DayFirstHalfOrders(orders, targetDate = getTodayBizDate()) {
  const y = targetDate.getFullYear(), m = targetDate.getMonth();
  return orders.filter(o => {
    if (!isEligibleForReport(o)) return false;
    const b = getOrderBizDate(o);
    return b && b.getFullYear() === y && b.getMonth() === m && b.getDate() >= 1 && b.getDate() <= 15;
  });
}

function get15DaySecondHalfOrders(orders, targetDate = getTodayBizDate()) {
  const y = targetDate.getFullYear(), m = targetDate.getMonth();
  return orders.filter(o => {
    if (!isEligibleForReport(o)) return false;
    const b = getOrderBizDate(o);
    return b && b.getFullYear() === y && b.getMonth() === m && b.getDate() >= 16;
  });
}

function getMonthlyOrders(orders, targetDate = getTodayBizDate()) {
  const y = targetDate.getFullYear(), m = targetDate.getMonth();
  return orders.filter(o => {
    if (!isEligibleForReport(o)) return false;
    const b = getOrderBizDate(o);
    return b && b.getFullYear() === y && b.getMonth() === m;
  });
}

async function run() {
  const db = openDatabase();
  const orders = await getOrders(db, { includeCompleted: true, forReports: true });
  console.log('Total orders in DB for reports:', orders.length);

  const daily = getDailyOrders(orders);
  console.log('Daily orders count for today (09-Sep):', daily.length);

  const m15_1 = get15DayFirstHalfOrders(orders);
  console.log('15-Day (1st-15th Sep) orders count:', m15_1.length);

  const monthly = getMonthlyOrders(orders);
  console.log('Monthly (Full Sep) orders count:', monthly.length);

  function groupDates(arr) {
    const g = {};
    arr.forEach(o => {
      const b = getOrderBizDate(o);
      const ds = `${String(b.getDate()).padStart(2, '0')}-${b.toLocaleString('en-US', { month: 'short' })}-${b.getFullYear()}`;
      g[ds] = (g[ds] || 0) + 1;
    });
    return g;
  }

  console.log('15-Day Date breakdown:', groupDates(m15_1));
  console.log('Monthly Date breakdown:', groupDates(monthly));

  process.exit(0);
}

run();
