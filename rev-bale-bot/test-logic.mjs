import { haversineM, stationKey, nearestStations, validPhone, parsePorts, stationCompatible, consumptionKwh100, portLabel } from "./worker.mjs";
let fail = 0;
const eq = (name, cond) => { console.log((cond ? "PASS" : "FAIL") + " " + name); if (!cond) fail++; };
// تهران تا قم حدود ۱۲۷ کیلومتر
const d = haversineM(35.6892, 51.3890, 34.6416, 50.8746);
eq("haversine Tehran-Qom ~127km", d > 120000 && d < 135000);
// کلید ایستگاه باید با رگکس ورکر وضعیت یکی باشد
const re = /^g:-?\d{1,3}\.\d{6},-?\d{1,3}\.\d{6}$/;
eq("stationKey format", re.test(stationKey(35.8001102735036, 51.489715436473496)));
eq("stationKey value", stationKey(35.8, 51.5) === "g:35.800000,51.500000");
// نزدیک‌ترین‌ها: مرتب‌سازی و سقف شعاع
const sts = [
  { name: "دور", latitude: 35.9, longitude: 51.6 },
  { name: "نزدیک", latitude: 35.6895, longitude: 51.3893 },
  { name: "خیلی دور", latitude: 36.5, longitude: 52.5 },
];
const near = nearestStations(sts, 35.6892, 51.3890);
eq("nearest count<=2 within 3km", near.length === 1 && near[0].name === "نزدیک");
eq("nearest dist sane", near[0].distM < 100);
// شماره موبایل
eq("phone ok", validPhone("09123456789"));
eq("phone bad", !validPhone("9123456789") && !validPhone("0912345678"));
// فاز ۲: پورت و سازگاری
eq("parsePorts ccs", parsePorts("CCS2").join() === "ccs2");
eq("parsePorts gbt both", parsePorts("GB/T").sort().join() === "gbt_ac,gbt_dc");
eq("parsePorts messy array", parsePorts(["Type 2", { x: "CHAdeMO" }]).sort().join() === "chademo,type2");
eq("compat true", stationCompatible({ connectors: "CCS2, Type 2" }, "ccs2"));
eq("compat false", !stationCompatible({ connectors: "GB/T DC" }, "ccs2"));
eq("compat unknown ok", stationCompatible({ connectors: "" }, "ccs2") && stationCompatible({}, null));
eq("portLabel", portLabel("gbt_dc").includes("GB/T"));
// فاز ۲: ماشین‌حساب (فرمول رانش: ظرفیت ÷ برد × ۱۰۰)
eq("consumption 50.3/400", consumptionKwh100(50.3, 400) === 12.6);
eq("consumption bad", consumptionKwh100(0, 400) === null && consumptionKwh100(50, 0) === null);
process.exit(fail ? 1 : 0);
