const demoDirectories = [
  { id: 1, name: "cli-launchpad", path: "C:\\Projects\\cli-launchpad" },
  { id: 2, name: "server-management", path: "C:\\Projects\\server-management" }
];

export function DirectoryList() {
  return (
    <div className="directory-list">
      <div className="section-heading">Directories</div>
      {demoDirectories.map((directory) => (
        <button className="directory-item" key={directory.id}>
          <strong>{directory.name}</strong>
          <span>{directory.path}</span>
        </button>
      ))}
    </div>
  );
}

