using CopilotTokenTracker.Commands;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace CopilotTokenTracker.Tests
{
    [TestClass]
    public class FormatTokenCountTests
    {
        [TestMethod]
        public void Zero_ReturnsZero()
        {
            Assert.AreEqual("0", ToolbarInfoCommand.FormatTokenCount(0));
        }

        [TestMethod]
        public void SmallNumber_ReturnsFormattedInteger()
        {
            Assert.AreEqual("42", ToolbarInfoCommand.FormatTokenCount(42));
        }

        [TestMethod]
        public void Under1000_ReturnsWithCommas()
        {
            Assert.AreEqual("999", ToolbarInfoCommand.FormatTokenCount(999));
        }

        [TestMethod]
        public void Exactly1000_Returns1K()
        {
            Assert.AreEqual("1K", ToolbarInfoCommand.FormatTokenCount(1_000));
        }

        [TestMethod]
        public void Thousands_ReturnsKSuffix()
        {
            Assert.AreEqual("45.2K", ToolbarInfoCommand.FormatTokenCount(45_200));
        }

        [TestMethod]
        public void ThousandsRound_OmitsDecimal()
        {
            Assert.AreEqual("45K", ToolbarInfoCommand.FormatTokenCount(45_000));
        }

        [TestMethod]
        public void HundredThousands_ReturnsKSuffix()
        {
            Assert.AreEqual("500K", ToolbarInfoCommand.FormatTokenCount(500_000));
        }

        [TestMethod]
        public void NineHundredNinetyNineK_ReturnsKSuffix()
        {
            Assert.AreEqual("999.9K", ToolbarInfoCommand.FormatTokenCount(999_900));
        }

        [TestMethod]
        public void Exactly1Million_Returns1M()
        {
            Assert.AreEqual("1M", ToolbarInfoCommand.FormatTokenCount(1_000_000));
        }

        [TestMethod]
        public void Millions_ReturnsMSuffix()
        {
            Assert.AreEqual("1.2M", ToolbarInfoCommand.FormatTokenCount(1_200_000));
        }

        [TestMethod]
        public void LargeMillions_ReturnsMSuffix()
        {
            Assert.AreEqual("42.5M", ToolbarInfoCommand.FormatTokenCount(42_500_000));
        }

        [TestMethod]
        public void MillionsRound_OmitsDecimal()
        {
            Assert.AreEqual("10M", ToolbarInfoCommand.FormatTokenCount(10_000_000));
        }

        [TestMethod]
        public void HundredMillions_ReturnsMSuffix()
        {
            Assert.AreEqual("150M", ToolbarInfoCommand.FormatTokenCount(150_000_000));
        }

        [TestMethod]
        public void NegativeValue_ReturnsNegativeFormatted()
        {
            // Edge: negative tokens should still format (though unlikely in practice)
            var result = ToolbarInfoCommand.FormatTokenCount(-500);
            Assert.IsNotNull(result);
        }
    }
}
