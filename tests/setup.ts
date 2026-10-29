// 测试用临时目录,不碰真实索引;时区固定(bun test 默认 UTC)
process.env.CC_INSIGHTS_DATA = `/tmp/cc-insights-test-${process.pid}`;
process.env.TZ = "Asia/Shanghai";
