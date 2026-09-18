



















use crate::agent::tool_registry::{ExecutableTool, ToolDef, ToolExecContext};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::OnceLock;





const WEATHER_PAYLOAD_KIND: &str = "weather_report";
const PAYLOAD_VERSION: u32 = 1;


const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

const MIN_DAYS: i64 = 1;
const MAX_DAYS: i64 = 7;
const DEFAULT_DAYS: i64 = 2;



fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            
            .user_agent("OneDesktop/1.0 (+weather-tool)")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}







#[derive(Debug, Default, Clone)]
struct CurrentConditions {
    desc: String,
    temp_c: Option<f64>,
    feels_c: Option<f64>,
    humidity: Option<f64>,
    wind_kmh: Option<f64>,
    wind_dir: Option<String>,
    visibility_km: Option<f64>,
}


#[derive(Debug, Default, Clone)]
struct DailyForecast {
    date: String,
    desc: String,
    max_c: Option<f64>,
    min_c: Option<f64>,
    rain_chance: Option<f64>,
    sunrise: String,
    sunset: String,
}



#[derive(Debug, Clone)]
struct WeatherReport {
    
    source: &'static str,
    area: String,
    current: Option<CurrentConditions>,
    days: Vec<DailyForecast>,
}




#[derive(Debug, Serialize)]
struct WeatherReportPayload<'a> {
    kind: &'a str,
    version: u32,
    
    source: &'a str,
    
    area: &'a str,
    
    summary: String,
    
    current: Vec<WeatherRow>,
    
    days: Vec<DailyBlock>,
}

#[derive(Debug, Serialize)]
struct WeatherRow {
    label: String,
    value: String,
}

#[derive(Debug, Serialize)]
struct DailyBlock {
    label: String,
    rows: Vec<WeatherRow>,
}

impl WeatherReport {
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    fn render(&self) -> String {
        let summary = format!("📍 {} 天气（来源 {}）", self.area, self.source);

        let current = self.current.as_ref().map(|c| {
            let temp_cell = match (c.temp_c, c.feels_c) {
                (Some(t), Some(f)) => format!("{}°C（体感 {}°C）", fmt_num(t), fmt_num(f)),
                (Some(t), None) => format!("{}°C", fmt_num(t)),
                (None, _) => "--".into(),
            };
            let wind_cell = match (c.wind_kmh, c.wind_dir.as_deref().filter(|s| !s.is_empty())) {
                (Some(w), Some(dir)) => format!("{dir} {} km/h", fmt_num(w)),
                (Some(w), None) => format!("{} km/h", fmt_num(w)),
                (None, _) => "--".into(),
            };
            vec![
                WeatherRow {
                    label: "天气".into(),
                    value: blank_to_dash_owned(&c.desc),
                },
                WeatherRow {
                    label: "气温".into(),
                    value: temp_cell,
                },
                WeatherRow {
                    label: "湿度".into(),
                    value: c
                        .humidity
                        .map(|h| format!("{}%", fmt_num(h)))
                        .unwrap_or_else(|| "--".into()),
                },
                WeatherRow {
                    label: "风".into(),
                    value: wind_cell,
                },
                WeatherRow {
                    label: "能见度".into(),
                    value: c
                        .visibility_km
                        .map(|v| format!("{} km", fmt_num(v)))
                        .unwrap_or_else(|| "--".into()),
                },
            ]
        });

        let days = self
            .days
            .iter()
            .enumerate()
            .map(|(i, d)| {
                
                let label = match i {
                    0 => format!("今天 · {}", d.date),
                    1 => format!("明天 · {}", d.date),
                    2 => format!("后天 · {}", d.date),
                    3 => format!("大后天 · {}", d.date),
                    _ => d.date.clone(),
                };
                let temp_cell = match (d.min_c, d.max_c) {
                    (Some(lo), Some(hi)) => format!("{} ~ {}°C", fmt_num(lo), fmt_num(hi)),
                    (None, Some(hi)) => format!("最高 {}°C", fmt_num(hi)),
                    (Some(lo), None) => format!("最低 {}°C", fmt_num(lo)),
                    (None, None) => "--".into(),
                };
                DailyBlock {
                    label,
                    rows: vec![
                        WeatherRow {
                            label: "天气".into(),
                            value: blank_to_dash_owned(&d.desc),
                        },
                        WeatherRow {
                            label: "气温".into(),
                            value: temp_cell,
                        },
                        WeatherRow {
                            label: "降水概率".into(),
                            value: d
                                .rain_chance
                                .map(|r| format!("{}%", fmt_num(r)))
                                .unwrap_or_else(|| "--".into()),
                        },
                        WeatherRow {
                            label: "日出".into(),
                            value: blank_to_dash_owned(&d.sunrise),
                        },
                        WeatherRow {
                            label: "日落".into(),
                            value: blank_to_dash_owned(&d.sunset),
                        },
                    ],
                }
            })
            .collect();

        let payload = WeatherReportPayload {
            kind: WEATHER_PAYLOAD_KIND,
            version: PAYLOAD_VERSION,
            source: self.source,
            area: &self.area,
            summary,
            current: current.unwrap_or_default(),
            days,
        };

        serde_json::to_string(&payload)
            .unwrap_or_else(|e| format!("{{\"kind\":\"weather_report\",\"error\":\"render failed: {e}\"}}"))
    }
}

fn blank_to_dash_owned(s: &str) -> String {
    if s.trim().is_empty() {
        "--".into()
    } else {
        s.to_string()
    }
}


fn fmt_num(v: f64) -> String {
    if (v - v.round()).abs() < f64::EPSILON {
        format!("{}", v.round() as i64)
    } else {
        format!("{:.1}", v)
    }
}





#[async_trait]
trait WeatherProvider: Send + Sync {
    
    fn name(&self) -> &'static str;
    async fn fetch(&self, location: &str, days: usize) -> Result<WeatherReport, String>;
}



fn providers() -> Vec<Box<dyn WeatherProvider>> {
    vec![Box::new(OpenMeteoProvider), Box::new(WttrProvider)]
}








async fn fetch_with_failover(
    chain: Vec<Box<dyn WeatherProvider>>,
    location: &str,
    days: usize,
) -> Result<String, String> {
    let mut failures = Vec::new();
    for p in chain {
        match p.fetch(location, days).await {
            Ok(report) => {
                let mut text = report.render();
                
                if !failures.is_empty() {
                    text.push_str(&format!(
                        "（注：主数据源不可用，已自动切换备用源 — {}）\n",
                        failures.join("；")
                    ));
                }
                return Ok(text);
            }
            Err(e) => failures.push(format!("{} {}", p.name(), e)),
        }
    }
    Err(format!("所有天气数据源均不可用：{}", failures.join("；")))
}





const OM_GEOCODE: &str = "https://geocoding-api.open-meteo.com/v1/search";
const OM_FORECAST: &str = "https://api.open-meteo.com/v1/forecast";

struct OpenMeteoProvider;

#[async_trait]
impl WeatherProvider for OpenMeteoProvider {
    fn name(&self) -> &'static str {
        "Open-Meteo"
    }

    async fn fetch(&self, location: &str, days: usize) -> Result<WeatherReport, String> {
        
        let geo_url = format!(
            "{}?name={}&count=1&language=zh&format=json",
            OM_GEOCODE,
            urlencode(location)
        );
        let geo: Value = get_json(&geo_url).await?;
        let hit = geo["results"]
            .get(0)
            .ok_or_else(|| format!("未找到地点「{}」", location))?;
        let lat = hit["latitude"].as_f64().ok_or("地理编码缺少纬度")?;
        let lon = hit["longitude"].as_f64().ok_or("地理编码缺少经度")?;

        
        let name = hit["name"].as_str().unwrap_or(location);
        let admin = hit["admin1"].as_str().unwrap_or("");
        let country = hit["country"].as_str().unwrap_or("");
        let area = if !admin.is_empty() && admin != name {
            format!("{}·{}", admin, name)
        } else if !country.is_empty() {
            format!("{}·{}", country, name)
        } else {
            name.to_string()
        };

        let url = format!(
            "{OM_FORECAST}?latitude={lat}&longitude={lon}\
             &current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,\
wind_speed_10m,wind_direction_10m,visibility\
             &daily=weather_code,temperature_2m_max,temperature_2m_min,\
precipitation_probability_max,sunrise,sunset\
             &timezone=auto&forecast_days={days}"
        );
        let doc: Value = get_json(&url).await?;
        parse_open_meteo(&doc, area, days)
    }
}


fn parse_open_meteo(doc: &Value, area: String, days: usize) -> Result<WeatherReport, String> {
    let current = doc.get("current").map(|c| CurrentConditions {
        desc: wmo_to_zh(c["weather_code"].as_i64()).to_string(),
        temp_c: c["temperature_2m"].as_f64(),
        feels_c: c["apparent_temperature"].as_f64(),
        humidity: c["relative_humidity_2m"].as_f64(),
        wind_kmh: c["wind_speed_10m"].as_f64(),
        wind_dir: c["wind_direction_10m"].as_f64().map(deg_to_zh),
        
        visibility_km: c["visibility"].as_f64().map(|m| (m / 1000.0 * 10.0).round() / 10.0),
    });

    
    let daily = doc.get("daily").ok_or("天气数据缺少逐日预报")?;
    let dates = daily["time"].as_array().ok_or("逐日预报缺少日期")?;
    if dates.is_empty() {
        return Err("天气数据为空".into());
    }
    let col = |key: &str, i: usize| -> Option<f64> {
        daily[key].as_array().and_then(|a| a.get(i)).and_then(Value::as_f64)
    };
    let col_str = |key: &str, i: usize| -> String {
        daily[key]
            .as_array()
            .and_then(|a| a.get(i))
            .and_then(Value::as_str)
            
            .and_then(|s| s.split('T').nth(1))
            .unwrap_or("")
            .to_string()
    };

    let mut out = Vec::new();
    for (i, d) in dates.iter().take(days).enumerate() {
        out.push(DailyForecast {
            date: d.as_str().unwrap_or("--").to_string(),
            desc: wmo_to_zh(
                daily["weather_code"]
                    .as_array()
                    .and_then(|a| a.get(i))
                    .and_then(Value::as_i64),
            )
            .to_string(),
            max_c: col("temperature_2m_max", i),
            min_c: col("temperature_2m_min", i),
            rain_chance: col("precipitation_probability_max", i),
            sunrise: col_str("sunrise", i),
            sunset: col_str("sunset", i),
        });
    }

    Ok(WeatherReport {
        source: "Open-Meteo",
        area,
        current,
        days: out,
    })
}



fn wmo_to_zh(code: Option<i64>) -> &'static str {
    match code {
        Some(0) => "晴",
        Some(1) => "大部晴朗",
        Some(2) => "局部多云",
        Some(3) => "阴",
        Some(45) => "雾",
        Some(48) => "雾凇",
        Some(51) => "小毛毛雨",
        Some(53) => "毛毛雨",
        Some(55) => "大毛毛雨",
        Some(56) | Some(57) => "冻毛毛雨",
        Some(61) => "小雨",
        Some(63) => "中雨",
        Some(65) => "大雨",
        Some(66) | Some(67) => "冻雨",
        Some(71) => "小雪",
        Some(73) => "中雪",
        Some(75) => "大雪",
        Some(77) => "雪粒",
        Some(80) => "小阵雨",
        Some(81) => "阵雨",
        Some(82) => "强阵雨",
        Some(85) => "小阵雪",
        Some(86) => "大阵雪",
        Some(95) => "雷阵雨",
        Some(96) | Some(99) => "雷阵雨伴冰雹",
        _ => "未知",
    }
}


fn deg_to_zh(deg: f64) -> String {
    const POINTS: [&str; 16] = [
        "北", "北东北", "东北", "东东北", "东", "东东南", "东南", "南东南", "南", "南西南",
        "西南", "西西南", "西", "西西北", "西北", "北西北",
    ];
    let idx = (((deg % 360.0 + 360.0) % 360.0) / 22.5).round() as usize % 16;
    POINTS[idx].to_string()
}





const WTTR_BASE: &str = "https://wttr.in";

const WTTR_MAX_DAYS: usize = 3;

struct WttrProvider;

#[async_trait]
impl WeatherProvider for WttrProvider {
    fn name(&self) -> &'static str {
        "wttr.in"
    }

    async fn fetch(&self, location: &str, days: usize) -> Result<WeatherReport, String> {
        let url = format!("{}/{}?format=j1&lang=zh&n=1", WTTR_BASE, urlencode(location));
        let doc: Value = get_json(&url).await?;
        parse_wttr(&doc, location, days.min(WTTR_MAX_DAYS))
    }
}

fn parse_wttr(doc: &Value, location: &str, days: usize) -> Result<WeatherReport, String> {
    let area = doc["nearest_area"]
        .get(0)
        .and_then(|a| a["areaName"].get(0))
        .and_then(|n| n["value"].as_str())
        .unwrap_or(location)
        .to_string();

    
    
    let num = |v: &Value| -> Option<f64> { v.as_str().and_then(|s| s.parse::<f64>().ok()) };

    let current = doc["current_condition"].get(0).map(|cc| CurrentConditions {
        desc: cc["lang_zh"]
            .get(0)
            .and_then(|d| d["value"].as_str())
            .or_else(|| cc["weatherDesc"].get(0).and_then(|d| d["value"].as_str()))
            .unwrap_or("")
            .to_string(),
        temp_c: num(&cc["temp_C"]),
        feels_c: num(&cc["FeelsLikeC"]),
        humidity: num(&cc["humidity"]),
        wind_kmh: num(&cc["windspeedKmph"]),
        wind_dir: cc["winddir16Point"].as_str().map(str::to_string),
        visibility_km: num(&cc["visibility"]),
    });

    let list = doc["weather"].as_array().ok_or("天气数据缺少逐日预报")?;
    if list.is_empty() {
        return Err("天气数据为空".into());
    }

    let mut out = Vec::new();
    for day in list.iter().take(days) {
        
        let noon = day["hourly"]
            .as_array()
            .and_then(|hs| hs.iter().find(|h| h["time"].as_str() == Some("1200")))
            .or_else(|| day["hourly"].as_array().and_then(|hs| hs.first()));
        let desc = noon
            .and_then(|h| {
                h["lang_zh"]
                    .get(0)
                    .and_then(|x| x["value"].as_str())
                    .or_else(|| h["weatherDesc"].get(0).and_then(|x| x["value"].as_str()))
            })
            .unwrap_or("")
            .to_string();
        let rain = noon.and_then(|h| num(&h["chanceofrain"]));

        out.push(DailyForecast {
            date: day["date"].as_str().unwrap_or("--").to_string(),
            desc,
            max_c: num(&day["maxtempC"]),
            min_c: num(&day["mintempC"]),
            rain_chance: rain,
            sunrise: day["astronomy"]
                .get(0)
                .and_then(|a| a["sunrise"].as_str())
                .unwrap_or("")
                .to_string(),
            sunset: day["astronomy"]
                .get(0)
                .and_then(|a| a["sunset"].as_str())
                .unwrap_or("")
                .to_string(),
        });
    }

    Ok(WeatherReport {
        source: "wttr.in",
        area,
        current,
        days: out,
    })
}






async fn get_json(url: &str) -> Result<Value, String> {
    let resp = http()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("返回 HTTP {}", status));
    }
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;
    serde_json::from_str(&body).map_err(|e| format!("响应解析失败: {}", e))
}


fn urlencode(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
                c.to_string()
            } else {
                let mut buf = [0u8; 4];
                c.encode_utf8(&mut buf)
                    .bytes()
                    .map(|b| format!("%{:02X}", b))
                    .collect()
            }
        })
        .collect()
}





pub struct WeatherTool;

#[async_trait]
impl ExecutableTool for WeatherTool {
    async fn execute(&self, args: Value, _ctx: &ToolExecContext) -> Result<String, String> {
        let location = args["location"].as_str().ok_or("Missing 'location' argument")?;
        let location = location.trim();
        if location.is_empty() {
            return Err("'location' must not be empty".into());
        }
        let days = args
            .get("days")
            .and_then(Value::as_i64)
            .unwrap_or(DEFAULT_DAYS)
            .clamp(MIN_DAYS, MAX_DAYS) as usize;

        fetch_with_failover(providers(), location, days).await
    }
}

impl From<WeatherTool> for ToolDef {
    fn from(_: WeatherTool) -> Self {
        ToolDef {
            name: "get_weather".into(),
            description: concat!(
                "查询指定地点的实时天气与未来 1-7 天预报（温度、天气状况、湿度、风速、",
                "降水概率、日出日落）。参数 location 为城市名或地名（支持中文，如 \"北京\" / \"上海\"），",
                "days 为预报天数（1-7，缺省 2）。数据源自动故障转移（Open-Meteo → wttr.in），",
                "无鉴权、只读、可安全用于无人值守 Worker。\n\n",
                "【输出格式】工具返回的是一段结构化 JSON（kind=\"weather_report\"），前端",
                "会用专用组件自动渲染为完整表格（含实时 + 逐日）。**你不需要、也不应该在 markdown 里",
                "复述具体数据**（温度/天气状况/湿度/风速/降水概率/日出日落）—— 前端会替你呈现。",
                "只需给一句自然语言总结 + 一条出行/穿衣建议即可，例如：\"今天北京阴，气温 27°C 左右、",
                "湿度较大；建议带伞、穿薄外套。\"。"
            )
            .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "城市名或地名，如 \"北京\"、\"Shanghai\"、\"New York\""
                    },
                    "days": {
                        "type": "integer",
                        "description": "预报天数 1-7，缺省 2（今天+明天）",
                        "minimum": MIN_DAYS,
                        "maximum": MAX_DAYS
                    }
                },
                "required": ["location"]
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    
    
    #[tokio::test]
    async fn fetch_beijing_forecast() {
        let tool = WeatherTool;
        let out = tool
            .execute(
                json!({"location": "北京", "days": 2}),
                &ToolExecContext::default(),
            )
            .await;
        match out {
            Ok(text) => {
                
                eprintln!("[weather live]\n{}", text);
                assert!(text.contains("天气"), "缺标题: {}", text);
                assert!(text.contains("20"), "缺日期行: {}", text);
            }
            Err(e) => eprintln!("[weather offline] {}", e),
        }
    }

    
    struct StubProvider {
        name: &'static str,
        ok: bool,
    }

    #[async_trait]
    impl WeatherProvider for StubProvider {
        fn name(&self) -> &'static str {
            self.name
        }
        async fn fetch(&self, _loc: &str, _days: usize) -> Result<WeatherReport, String> {
            if self.ok {
                Ok(WeatherReport {
                    source: "备用源",
                    area: "测试市".into(),
                    current: None,
                    days: vec![DailyForecast {
                        date: "2026-08-06".into(),
                        desc: "晴".into(),
                        ..Default::default()
                    }],
                })
            } else {
                Err("返回 HTTP 500".into())
            }
        }
    }

    
    
    #[tokio::test]
    async fn failover_skips_dead_primary() {
        let chain: Vec<Box<dyn WeatherProvider>> = vec![
            Box::new(StubProvider { name: "主源", ok: false }),
            Box::new(StubProvider { name: "备源", ok: true }),
        ];
        let text = fetch_with_failover(chain, "北京", 2).await.expect("应回落成功");
        assert!(text.contains("测试市"), "{}", text);
        assert!(text.contains("已自动切换备用源"), "缺降级提示: {}", text);
        assert!(text.contains("主源 返回 HTTP 500"), "缺失败归因: {}", text);
    }

    
    #[tokio::test]
    async fn failover_stays_quiet_when_primary_healthy() {
        let chain: Vec<Box<dyn WeatherProvider>> = vec![
            Box::new(StubProvider { name: "主源", ok: true }),
            Box::new(StubProvider { name: "备源", ok: false }),
        ];
        let text = fetch_with_failover(chain, "北京", 2).await.expect("主源应直接成功");
        assert!(!text.contains("已自动切换"), "不该出现降级提示: {}", text);
    }

    
    #[tokio::test]
    async fn failover_reports_every_failure() {
        let chain: Vec<Box<dyn WeatherProvider>> = vec![
            Box::new(StubProvider { name: "主源", ok: false }),
            Box::new(StubProvider { name: "备源", ok: false }),
        ];
        let err = fetch_with_failover(chain, "北京", 2).await.unwrap_err();
        assert!(err.contains("所有天气数据源均不可用"), "{}", err);
        assert!(err.contains("主源") && err.contains("备源"), "缺逐源归因: {}", err);
    }

    fn open_meteo_fixture() -> Value {
        json!({
            "current": {
                "temperature_2m": 33.0,
                "apparent_temperature": 39.8,
                "relative_humidity_2m": 65,
                "weather_code": 3,
                "wind_speed_10m": 1.7,
                "wind_direction_10m": 41,
                "visibility": 10040.0
            },
            "daily": {
                "time": ["2026-08-06", "2026-08-07"],
                "weather_code": [95, 61],
                "temperature_2m_max": [36.5, 37.8],
                "temperature_2m_min": [28.0, 26.7],
                "precipitation_probability_max": [8, 80],
                "sunrise": ["2026-08-06T05:17", "2026-08-07T05:18"],
                "sunset": ["2026-08-06T19:23", "2026-08-07T19:22"]
            }
        })
    }

    
    #[test]
    fn parse_open_meteo_doc() {
        let r = parse_open_meteo(&open_meteo_fixture(), "北京市·北京".into(), 2).expect("parse");
        assert_eq!(r.source, "Open-Meteo");
        assert_eq!(r.days.len(), 2);

        let c = r.current.expect("current");
        assert_eq!(c.desc, "阴"); 
        assert_eq!(c.temp_c, Some(33.0));
        assert_eq!(c.visibility_km, Some(10.0)); 
        assert_eq!(c.wind_dir.as_deref(), Some("东北")); 

        assert_eq!(r.days[0].date, "2026-08-06");
        assert_eq!(r.days[0].desc, "雷阵雨"); 
        assert_eq!(r.days[0].sunrise, "05:17"); 
        assert_eq!(r.days[1].desc, "小雨"); 
        assert_eq!(r.days[1].rain_chance, Some(80.0));
    }

    
    #[test]
    fn parse_open_meteo_respects_day_limit() {
        let r = parse_open_meteo(&open_meteo_fixture(), "北京".into(), 1).expect("parse");
        assert_eq!(r.days.len(), 1);
    }

    
    
    #[test]
    fn parse_open_meteo_rejects_empty() {
        let err = parse_open_meteo(&json!({"current": {}}), "X".into(), 2).unwrap_err();
        assert!(err.contains("逐日预报"), "{}", err);
    }

    
    #[test]
    fn parse_wttr_doc() {
        let doc = json!({
            "nearest_area": [{"areaName": [{"value": "Beijing"}]}],
            "current_condition": [{
                "temp_C": "28", "FeelsLikeC": "30", "humidity": "60",
                "windspeedKmph": "12", "winddir16Point": "ESE", "visibility": "10",
                "lang_zh": [{"value": "晴"}], "weatherDesc": [{"value": "Sunny"}]
            }],
            "weather": [{
                "date": "2026-08-04",
                "maxtempC": "32", "mintempC": "24", "avgtempC": "28",
                "astronomy": [{"sunrise": "05:12 AM", "sunset": "07:20 PM"}],
                "hourly": [
                    {"time": "800", "tempC": "26", "chanceofrain": "10",
                     "lang_zh": [{"value": "多云"}]},
                    {"time": "1200", "tempC": "31", "chanceofrain": "20",
                     "lang_zh": [{"value": "晴"}]}
                ]
            }]
        });
        let r = parse_wttr(&doc, "北京", 3).expect("parse");
        assert_eq!(r.source, "wttr.in");
        assert_eq!(r.area, "Beijing");
        let c = r.current.expect("current");
        assert_eq!(c.temp_c, Some(28.0)); 
        assert_eq!(r.days[0].desc, "晴"); 
        assert_eq!(r.days[0].rain_chance, Some(20.0));
    }

    
    
    
    
    
    #[test]
    fn render_is_readable() {
        let r = parse_open_meteo(&open_meteo_fixture(), "北京市·北京".into(), 2).expect("parse");
        let text = r.render();
        
        let v: Value = serde_json::from_str(&text).expect("render 应返回合法 JSON");
        assert_eq!(v["kind"], "weather_report", "kind 标签必须等于 weather_report");
        assert_eq!(v["version"], 1, "version 必须是 1");
        assert_eq!(v["source"], "Open-Meteo");
        assert_eq!(v["area"], "北京市·北京");
        
        assert!(v["summary"].as_str().unwrap().contains("北京市·北京"));
        
        let current = v["current"].as_array().expect("current 必须是数组");
        assert_eq!(current.len(), 5, "实时必须 5 行: {}", text);
        let labels: Vec<&str> = current.iter().map(|r| r["label"].as_str().unwrap()).collect();
        assert_eq!(labels, vec!["天气", "气温", "湿度", "风", "能见度"]);
        let current_text = serde_json::to_string(&current).unwrap();
        assert!(current_text.contains("33°C"), "缺当前温度值: {}", text);
        assert!(current_text.contains("39.8"), "体感不在同一格: {}", text);
        
        let days = v["days"].as_array().expect("days 必须是数组");
        assert_eq!(days.len(), 2, "fixture 是 2 天");
        for (i, d) in days.iter().enumerate() {
            let rows = d["rows"].as_array().expect("rows 必须是数组");
            assert_eq!(rows.len(), 5, "第 {} 天必须 5 行", i);
        }
        let all = serde_json::to_string(&v).unwrap();
        assert!(all.contains("今天"), "缺今天标签: {}", text);
        assert!(all.contains("明天"), "缺明天标签: {}", text);
        assert!(all.contains("2026-08-06"), "缺日期: {}", text);
        assert!(all.contains("2026-08-07"), "缺日期: {}", text);
        assert!(all.contains("降水概率"), "缺降水概率: {}", text);
        assert!(all.contains("日出"), "缺日出: {}", text);
        assert!(all.contains("日落"), "缺日落: {}", text);
        assert!(all.contains("05:17"), "缺时间: {}", text);
    }

    
    #[test]
    fn render_tolerates_missing_fields() {
        let r = WeatherReport {
            source: "Open-Meteo",
            area: "某地".into(),
            current: None,
            days: vec![DailyForecast {
                date: "2026-08-06".into(),
                ..Default::default()
            }],
        };
        let text = r.render();
        let v: Value = serde_json::from_str(&text).expect("应合法 JSON");
        
        let current = v["current"].as_array().expect("current 是数组");
        assert!(current.is_empty(), "current 应为空数组: {}", text);
        
        let days = v["days"].as_array().expect("days 是数组");
        assert_eq!(days.len(), 1);
        let rows = days[0]["rows"].as_array().expect("rows 是数组");
        assert_eq!(rows.len(), 5);
        for row in rows {
            assert_eq!(row["value"], "--", "缺值应统一显示 --: {}", text);
        }
        assert!(!text.contains("None"), "{}", text);
    }

    #[test]
    fn wmo_mapping() {
        assert_eq!(wmo_to_zh(Some(0)), "晴");
        assert_eq!(wmo_to_zh(Some(65)), "大雨");
        assert_eq!(wmo_to_zh(Some(99)), "雷阵雨伴冰雹");
        
        assert_eq!(wmo_to_zh(Some(12345)), "未知");
        assert_eq!(wmo_to_zh(None), "未知");
    }

    #[test]
    fn wind_direction_mapping() {
        assert_eq!(deg_to_zh(0.0), "北");
        assert_eq!(deg_to_zh(90.0), "东");
        assert_eq!(deg_to_zh(180.0), "南");
        assert_eq!(deg_to_zh(270.0), "西");
        assert_eq!(deg_to_zh(45.0), "东北");
        assert_eq!(deg_to_zh(359.0), "北"); 
        assert_eq!(deg_to_zh(-90.0), "西"); 
    }

    
    #[test]
    fn provider_chain_order() {
        let names: Vec<_> = providers().iter().map(|p| p.name()).collect();
        assert_eq!(names, vec!["Open-Meteo", "wttr.in"]);
    }

    #[test]
    fn url_encode_cjk() {
        assert_eq!(urlencode("北京"), "%E5%8C%97%E4%BA%AC");
        assert_eq!(urlencode("New York"), "New%20York");
        assert_eq!(urlencode("Shanghai"), "Shanghai");
    }
}
