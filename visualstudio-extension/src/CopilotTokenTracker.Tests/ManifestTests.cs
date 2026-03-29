using Microsoft.VisualStudio.TestTools.UnitTesting;
using System.IO;
using System.Xml.Linq;

namespace CopilotTokenTracker.Tests
{
    [TestClass]
    public class ManifestTests
    {
        private static readonly string ManifestPath =
            Path.Combine(AppContext.BaseDirectory, "source.extension.vsixmanifest");

        [TestMethod]
        public void VsixManifest_DescriptionUnder280Characters()
        {
            Assert.IsTrue(File.Exists(ManifestPath), $"Manifest not found at: {ManifestPath}");

            var doc = XDocument.Load(ManifestPath);
            XNamespace ns = "http://schemas.microsoft.com/developer/vsx-schema/2011";

            var description = doc.Root?
                .Element(ns + "Metadata")?
                .Element(ns + "Description")?
                .Value?.Trim();

            Assert.IsNotNull(description, "Description element not found in vsixmanifest");
            Assert.IsTrue(
                description.Length <= 280,
                $"Description is {description.Length} characters — Visual Studio Marketplace requires ≤ 280. Current value: \"{description}\"");
        }

        [TestMethod]
        public void VsixManifest_DescriptionNotEmpty()
        {
            Assert.IsTrue(File.Exists(ManifestPath), $"Manifest not found at: {ManifestPath}");

            var doc = XDocument.Load(ManifestPath);
            XNamespace ns = "http://schemas.microsoft.com/developer/vsx-schema/2011";

            var description = doc.Root?
                .Element(ns + "Metadata")?
                .Element(ns + "Description")?
                .Value?.Trim();

            Assert.IsNotNull(description, "Description element not found in vsixmanifest");
            Assert.IsFalse(string.IsNullOrWhiteSpace(description), "Description must not be empty");
        }
    }
}
