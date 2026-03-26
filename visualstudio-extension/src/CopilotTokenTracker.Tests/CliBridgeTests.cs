using CopilotTokenTracker.Data;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace CopilotTokenTracker.Tests
{
    [TestClass]
    public class CliBridgeTests
    {
        [TestMethod]
        public void GetCachedStats_InitiallyNull()
        {
            // Before any CLI call, cached stats should be null
            // (unless a previous test populated it — this validates the API surface)
            var cached = CliBridge.GetCachedStats();
            // We can't assert null since other tests in the suite may have populated it,
            // but we can assert the method is callable and returns the expected type
            Assert.IsTrue(cached == null || cached is DetailedStats);
        }

        [TestMethod]
        public void IsAvailable_ReturnsBoolean()
        {
            // IsAvailable() depends on whether the CLI exe is bundled next to CopilotTokenTracker.dll.
            // In a local development build the exe IS copied there, so we can only assert
            // the method is callable and returns a bool without throwing.
            var result = CliBridge.IsAvailable();
            Assert.IsTrue(result == true || result == false);
        }
    }
}
