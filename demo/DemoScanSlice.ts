import {BaseSlice, reducer, selector, asyncTask, rejected, SliceObject} from "../redux/BaseSlice";
import {Credential} from "./data/Credentials";
import {AddressSecretInfo} from "./ScanSlice";
import {rejectedTip} from "../ui/UISlice";
import {ensureSign, SignInfo, signMgr} from "../user/SignManager";
import {buildPoseidon} from "@sismo-core/crypto";
import {KVMerkleTree} from "@sismo-core/kv-merkle-tree";
import {AddressTreeHeight, HydraS1Prover, RegistryTreeHeight} from "./zk/hydra-s1-prover";
import {ethereum} from "../web3/ethereum/EthereumManager";
import {MathUtils} from "../../utils/MathUtils";
import {BigNumber} from "ethers";
import {ZKIDContract} from "./abi/ZKIDABI";
import {deepCopy} from "../../utils/TypeUtils";
import {SnarkProof} from "./zk/snark-proof";
import {
  GetCredential,
  GetCredentials,
  GetEddsaAccountPubKey,
  GetRegistryRoot,
  MintSBT,
  PushCommitment
} from "./ScanAPI";

export type DemoScanState = {
  credentials: Credential[]
  registryRoot: string,

  scannedAddress: string
  scannedCredentialIds: string[]

  sourceInfo: AddressSecretInfo

  isDone: boolean
  isSigning: boolean // 切换地址
  isSwitching: boolean // 切换地址
  isGenerating: boolean // 生成ZKProof

  generatedIdx: number // 正在生成的序号

  isMinting: boolean // 生成ZKProof

  sbtTokenId: string
  sbtAddress: string
  sbtTxHashes: string[]
}
const InitialState: DemoScanState = {
  credentials: [],
  registryRoot: "",

  scannedAddress: null,
  scannedCredentialIds: null,

  sourceInfo: null,

  isDone: false,
  isSigning: false,
  isSwitching: false,
  isGenerating: false,

  generatedIdx: -1,

  isMinting: false,

  sbtTokenId: null,
  sbtAddress: null,
  sbtTxHashes: null
}

export class DemoScanSlice extends BaseSlice<"demoScan", DemoScanState> {

  public get name(): "demoScan" { return "demoScan"; }
  public get initialState() { return InitialState; }

  // region 快捷访问

  // endregion

  // region Selector

  @selector
  public getCredential(id: string) {
    return this.state.credentials.find(c => c.id == id);
  }

  // endregion

  // region Reducer

  @reducer
  public resetMint() {
    this.setState({
      isSwitching: false,
      isSigning: false,
      isMinting: false,
      isGenerating: false
    })
  }

  // endregion

  // region AsyncTask

  @asyncTask
  @rejectedTip("Fetch credentials failed!")
  public async fetchCredentials() {
    const credentials = await GetCredentials();
    this.setState({ credentials });
  }

  @asyncTask
  @rejectedTip("Fetch credentials failed!")
  public async fetchCredential(id: string) {
    const idx = this.state.credentials.findIndex(c => c.id == id);
    const credential = this.state.credentials[idx];
    if (credential.addresses && credential.addresses.length > 0)
      return credential.addresses;

    try {
      const {addresses, addressesRoot} = await GetCredential({id});
      this.setState({
        [`credentials[${idx}].addressesRoot`]: addressesRoot,
        [`credentials[${idx}].addresses`]: addresses
      });
      return addresses;
    } catch (e) {
      console.error("fetchCredential error", e);
      return [];
    }
  }

  @asyncTask
  @ensureSign("scan")
  public async scanUser(address: string) {
    // TODO: 测试地址
    // address = "0xb650131a49cb1193a359c2674e3564eb366fcfaf";
    const credentials = this.state.credentials;
    const credAddresses = await Promise.all(
      credentials.map(c => this.fetchCredential(c.id)))

    const scannedCredentialIds = credAddresses
      .map((addresses, idx) => addresses
        .map(a => a.toLowerCase())
        .includes(address.toLowerCase()) && credentials[idx].id)
      .filter(id => !!id);
    // const scannedCredentialIds = credAddresses
    //   .map((addresses, idx) => credentials[idx].id)
    //   .filter(id => !!id);

    console.log("scanUser", {credentials, credAddresses, scannedCredentialIds})

    this.setState({
      scannedAddress: address,
      scannedCredentialIds
    })
  }

  public async getRegistryRoot() {
    let registryRoot = this.state.registryRoot;
    if (registryRoot) {
      registryRoot = await GetRegistryRoot();
      this.setState({registryRoot});
    }
    return registryRoot;
  }

  public async getAddressesTree(credential: Credential) {
    const poseidon = await buildPoseidon();
    // const addressesTreeData = credential.addresses.reduce(
    //   (res, addr) => ({...res, [addr]: 1}), {}
    // );
    const addressesTreeData = {}
    for (const addr of credential.addresses) addressesTreeData[addr] = 1;

    return new KVMerkleTree(addressesTreeData, poseidon, AddressTreeHeight);
  }

  public async getRegistryTree(credentials: Credential[]) {
    const poseidon = await buildPoseidon();
    // const registryData = credentials.reduce(
    //   (res, c) => ({...res, [c.addressesRoot]: 1}), {}
    // );
    const registryData = {}
    for (const c of credentials) registryData[c.addressesRoot] = 1;

    return new KVMerkleTree(registryData, poseidon, RegistryTreeHeight);
  }

  public async makeAddressSecretInfo(
    includeTokenId?, address?: string, poseidon?) {
    console.log("makeAddressSecretInfo")

    poseidon ||= await buildPoseidon();
    address ||= this.allState.web3.account?.address;

    console.log("makeAddressSecretInfo", {poseidon, address});

    const web3 = ethereum().web3;

    const secret = "0x" + MathUtils.randomString(32, "0123456789ABCDEF"); // web3.eth.accounts.create().privateKey;
    console.log("secret", secret)

    const commitmentBN = poseidon([secret]);
    const commitment = commitmentBN.toString();
    console.log("commitmentBN", {commitmentBN});

    const zkSignInfo = await signMgr().sign("zkproof",
      {commitment}, false) as SignInfo;
    console.log("zkSignInfo", zkSignInfo);

    const { commitmentMapperPubKey, commitmentReceipt } = await PushCommitment(zkSignInfo);
    const pubKey = commitmentMapperPubKey.map(
      pk => BigNumber.from(pk)) as [BigNumber, BigNumber];
    const receipt = commitmentReceipt.map(
      r => BigNumber.from(r)) as [BigNumber, BigNumber, BigNumber]
    console.log("pubKey receipt", { pubKey, receipt });

    let identifier = address;
    if (includeTokenId) {
      const tokenId = await ZKIDContract.methods.getTokenIdByAddress({owner: address}).call();
      identifier += BigNumber.from(tokenId).toHexString().slice(2).padStart(20, "0");
    }

    return {
      identifier, secret, commitmentReceipt: receipt
    }
  }

  @asyncTask
  @rejected(() => demoScanSlice.resetMint())
  public async makeSourceAddressSecretInfo() {
    this.setState({ isSigning: true })
    this.setState({
      sourceInfo: await this.makeAddressSecretInfo(),
      isSigning: false
    })
  }

  @asyncTask
  @rejected(() => demoScanSlice.resetMint())
  // @ensureSign("zkproof")
  public async generateZKProof() {

    this.setState({ isSwitching: false, isGenerating: true })

    const account = this.allState.web3.account;
    const chainId = account.chainId

    const credentials = this.state.credentials;
    const scannedCredentialIds = this.state.scannedCredentialIds;

    const scannedCredentials = scannedCredentialIds
      ?.map(id => credentials.find(c => c.id == id)) || [];

    const source = deepCopy(this.state.sourceInfo);
    const destination = await this.makeAddressSecretInfo(true);

    const commitmentMapperPubKey = await GetEddsaAccountPubKey();
    const pubKey = commitmentMapperPubKey.map(
      pk => BigNumber.from(pk)) as [BigNumber, BigNumber];

    const registryTree = await this.getRegistryTree(credentials);
    console.log("registryTree", { registryTree });

    const prover = new HydraS1Prover(registryTree, pubKey);
    console.log("prover", { prover });

    const snarkProofs: SnarkProof[] = []
    for (const c of scannedCredentials) {
      const accountsTree = await this.getAddressesTree(c)
      const externalNullifier = BigNumber.from(c.id);

      const isStrict = Boolean(registryTree
        .getValue(accountsTree.getRoot().toHexString())
        .toNumber());

      const params = {
        source, destination, chainId,
        claimedValue: 1,
        accountsTree, externalNullifier, isStrict
      }
      console.log("params", { params, c });

      const snarkProof = await prover.generateSnarkProof(params);
      console.log("snarkProof", { snarkProof, c });

      snarkProofs.push(snarkProof);

      this.setState({
        generatedIdx: snarkProofs.length - 1
      })
    }

    this.setState({ isGenerating: false, isMinting: true })

    const mintSignInfo = await signMgr().sign("mint", {}, false) as SignInfo;
    console.log("mintSignInfo", mintSignInfo);

    // const snarkProof = JSON.parse(JSON.stringify(snarkProofs[0]));
    // console.log("snarkProof", snarkProof);
    // const tx = await ZKIDContract.methods.createCredential(snarkProof)
    //   .quickSend();
    //   // .quickSend({from: account.address});
    // console.log("tx", tx);

    const { address, tokenId, txHashes } = await MintSBT({
      ...mintSignInfo, snarkProofs
    });
    // const { tokenId, address, txHash } = {
    //   tokenId: "0",
    //   address: "0x8aeb26dda4c44a1da71106c3d5ac3f3f87a79f8f",
    //   txHash: "0x087bf3fe0e869eb6334483ffe053dc1633952699ee91fc62b65e61c8007e04c3"
    // }

    this.setState({
      isMinting: false,
      sbtAddress: address,
      sbtTokenId: tokenId,
      sbtTxHashes: txHashes
    })

    // this.setState({ isDone: true })
  }

  // endregion

}

export const demoScanSlice: SliceObject<DemoScanSlice> = new DemoScanSlice();

// let _tmp;
// export function userSlice(): SliceObject<UserSlice> {
//   return _tmp ||= new UserSlice();
// }
