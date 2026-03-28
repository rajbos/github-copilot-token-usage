using CopilotTokenTracker.Data;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace CopilotTokenTracker.Tests
{
    [TestClass]
    public class StatsBuilderTests
    {
        [TestMethod]
        public void MapEnvironmentalPeriod_CopiesAllFields()
        {
            var period = new PeriodStats
            {
                Tokens = 500_000,
                Co2 = 0.125,
                TreesEquivalent = 0.008,
                WaterUsage = 2.5,
            };

            var result = StatsBuilder.MapEnvironmentalPeriod(period);

            Assert.AreEqual(500_000, result.Tokens);
            Assert.AreEqual(0.125, result.Co2, 0.0001);
            Assert.AreEqual(0.008, result.TreesEquivalent, 0.00001);
            Assert.AreEqual(2.5, result.WaterUsage, 0.01);
        }

        [TestMethod]
        public void MapEnvironmentalPeriod_ZeroValues()
        {
            var period = new PeriodStats();

            var result = StatsBuilder.MapEnvironmentalPeriod(period);

            Assert.AreEqual(0, result.Tokens);
            Assert.AreEqual(0.0, result.Co2);
            Assert.AreEqual(0.0, result.TreesEquivalent);
            Assert.AreEqual(0.0, result.WaterUsage);
        }

        [TestMethod]
        public void MapEnvironmentalPeriod_LargeValues()
        {
            var period = new PeriodStats
            {
                Tokens = 100_000_000,
                Co2 = 25.5,
                TreesEquivalent = 1.75,
                WaterUsage = 500.3,
            };

            var result = StatsBuilder.MapEnvironmentalPeriod(period);

            Assert.AreEqual(100_000_000, result.Tokens);
            Assert.AreEqual(25.5, result.Co2, 0.01);
            Assert.AreEqual(1.75, result.TreesEquivalent, 0.001);
            Assert.AreEqual(500.3, result.WaterUsage, 0.01);
        }

        [TestMethod]
        public void MapEnvironmentalPeriod_DoesNotCopyNonEnvironmentalFields()
        {
            var period = new PeriodStats
            {
                Tokens = 50_000,
                Sessions = 10,
                EstimatedCost = 5.00,
                ThinkingTokens = 3000,
                Co2 = 0.01,
            };

            var result = StatsBuilder.MapEnvironmentalPeriod(period);

            // Only Tokens, Co2, TreesEquivalent, WaterUsage should be mapped
            Assert.AreEqual(50_000, result.Tokens);
            Assert.AreEqual(0.01, result.Co2, 0.001);
        }
    }
}
